#!/usr/bin/env python3
"""
Genera chatbot/esWords.ts: un filtro de Bloom (≈1 % de falsos positivos) con las formas del diccionario de español de
hunspell (es_ES, licencia GPL/LGPL/MPL) más el vocabulario propio de la tienda. El asistente lo usa (chatbot/spanishGuard.ts)
para detectar palabras que no existen en español en lo que escribe el modelo (MiniMax a veces mete «waitress», «mingle»…).

Uso:
  python3 scripts/build-es-bloom.py es_ES.dic es_ES.aff [extra.txt] > chatbot/esWords.ts
  - extra.txt: palabras de la tienda, una por línea, en minúsculas (nombres de producto que no están en el diccionario).

El hash tiene que coincidir con el de spanishGuard.ts: FNV-1a de 32 bits (h1) y h2 = h*33+byte con semilla 5381 (impar),
índice i = (h1 + i*h2) mod m, k = 7. Los bits se numeran por byte (idx>>3) y bit (idx&7).
"""
import base64, collections, math, re, sys

K = 7
BITS_PER_WORD = 9.6  # ≈ 1 % de falsos positivos con k = 7


def parse_aff(path):
    pfx, sfx, cross = collections.defaultdict(list), collections.defaultdict(list), {}
    for line in open(path, encoding='utf-8'):
        p = line.split()
        if len(p) >= 4 and p[0] in ('PFX', 'SFX') and p[2] in ('Y', 'N') and p[3].isdigit():
            cross[(p[0], p[1])] = (p[2] == 'Y')
        elif len(p) >= 4 and p[0] in ('PFX', 'SFX'):
            kind, flag, strip, add = p[0], p[1], p[2], p[3]
            cond = p[4] if len(p) > 4 else '.'
            strip = '' if strip == '0' else strip
            conts = ''
            if '/' in add:
                add, conts = add.split('/', 1)
            add = '' if add == '0' else add
            rx = re.compile(cond + '$' if kind == 'SFX' else '^' + cond)
            (sfx if kind == 'SFX' else pfx)[flag].append((strip, add, rx, conts))
    return pfx, sfx, cross


def apply(word, flag, table, kind):
    out = []
    for strip, add, rx, conts in table.get(flag, []):
        if not rx.search(word):
            continue
        if kind == 'SFX':
            if strip and not word.endswith(strip):
                continue
            out.append((word[:len(word) - len(strip)] + add, conts))
        else:
            if strip and not word.startswith(strip):
                continue
            out.append((add + word[len(strip):], conts))
    return out


def expand(dic, aff, depth=3):
    pfx, sfx, cross = parse_aff(aff)
    res = set()

    def gen(word, flags, d, pflags):
        for f in flags:
            for nw, conts in apply(word, f, sfx, 'SFX'):
                res.add(nw)
                if conts and d > 0:
                    gen(nw, conts, d - 1, pflags)
                if cross.get(('SFX', f)):
                    for g in pflags:
                        if cross.get(('PFX', g)):
                            for pw, _ in apply(nw, g, pfx, 'PFX'):
                                res.add(pw)
            for nw, conts in apply(word, f, pfx, 'PFX'):
                res.add(nw)
                if conts and d > 0:
                    gen(nw, conts, d - 1, '')

    for line in open(dic, encoding='utf-8', errors='ignore').read().split('\n')[1:]:
        line = line.strip()
        if not line:
            continue
        w = line.split('\t')[0].split(' ')[0]
        flags = ''
        if '/' in w:
            w, flags = w.split('/', 1)
        res.add(w)
        if flags:
            gen(w, flags, depth, flags)
    return {x.lower() for x in res if x and x.replace('-', '').isalpha()}


def hashes(word):
    h1, h2 = 0x811c9dc5, 5381
    for b in word.encode('utf-8'):
        h1 = ((h1 ^ b) * 16777619) & 0xffffffff
        h2 = (h2 * 33 + b) & 0xffffffff
    return h1, h2 | 1


def main():
    dic, aff = sys.argv[1], sys.argv[2]
    words = expand(dic, aff)
    if len(sys.argv) > 3:
        words |= {w.strip().lower() for w in open(sys.argv[3], encoding='utf-8') if w.strip()}
    n = len(words)
    m = int(math.ceil(n * BITS_PER_WORD / 8) * 8)
    bits = bytearray(m // 8)
    for w in words:
        h1, h2 = hashes(w)
        for i in range(K):
            idx = (h1 + i * h2) % m
            bits[idx >> 3] |= 1 << (idx & 7)
    b64 = base64.b64encode(bytes(bits)).decode()
    print('// Generado por scripts/build-es-bloom.py (no editar a mano). Filtro de Bloom con %d palabras del español (hunspell es_ES + tienda).' % n)
    print('export const ES_BLOOM_BITS = %d;' % m)
    print('export const ES_BLOOM_K = %d;' % K)
    print('export const ES_BLOOM_B64 = [')
    for i in range(0, len(b64), 120):
        print("  '%s'," % b64[i:i + 120])
    print("].join('');")


if __name__ == '__main__':
    main()
