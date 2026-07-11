#!/usr/bin/env python3
"""
Script para regenerar imagenes de productos desde Bihr
Uso: python3 regenerate_images.py --limit 1000
"""

import os
import sys
import json
import time
import signal
import argparse
from datetime import datetime
from pathlib import Path

import requests
import psycopg2
from psycopg2.extras import RealDictCursor
from PIL import Image
import io

# ================================================================
# CONFIGURACION
# ================================================================
BIHR_API_BASE = os.environ.get('BIHR_API_BASE', 'https://api.bihr.net')
BIHR_USERNAME = os.environ.get('BIHR_USERNAME', 'info@escapesymas.com')
BIHR_MACKEY = os.environ.get('BIHR_MACKEY', '')

DB_HOST = os.environ.get('DB_HOST', 'localhost')
DB_PORT = os.environ.get('DB_PORT', '5432')
DB_NAME = os.environ.get('DB_NAME', 'escapes_db')
DB_USER = os.environ.get('DB_USER', 'postgres')
DB_PASSWORD = os.environ.get('DB_PASSWORD', '')

UPLOADS_DIR = '/var/www/vhosts/escapesymas.com/app/public/uploads/optimized'

SIZES = {
    'desktop': (800, 800),
    'mobile': (400, 400),
    'card-desktop': (400, 400),
    'card-mobile': (300, 300)
}

STATE_FILE = '/tmp/image_regen_state.json'


class ImageRegenerator:
    def __init__(self, batch_size=50, delay_between=0.5):
        self.batch_size = batch_size
        self.delay_between = delay_between
        self.token = None
        self.token_expiry = 0
        self.running = True
        self.stats = {
            'total': 0,
            'processed': 0,
            'success': 0,
            'failed': 0,
            'skipped': 0,
            'start_time': None,
            'current_id': 0,
            'status': 'idle'
        }

        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

    def signal_handler(self, signum, frame):
        print("\n[STOP] Saving state...")
        self.running = False
        self.save_state()
        sys.exit(0)

    def save_state(self):
        with open(STATE_FILE, 'w') as f:
            json.dump(self.stats, f)

    def load_state(self):
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
        return None

    def get_db_connection(self):
        return psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD,
            cursor_factory=RealDictCursor
        )

    def get_bihr_token(self):
        if not BIHR_USERNAME or BIHR_USERNAME == 'TEST_USER':
            print("[BIHR] No credentials, using placeholder mode")
            return 'mock_token'

        current_time = time.time()
        if self.token and current_time < self.token_expiry - 120:
            return self.token

        print("[BIHR] Requesting token...")
        try:
            response = requests.post(
                f"{BIHR_API_BASE}/api/v2.1/Authentication/Token",
                data={'UserName': BIHR_USERNAME, 'PassWord': BIHR_MACKEY},
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                timeout=30
            )
            if response.ok:
                data = response.json()
                self.token = data['access_token']
                self.token_expiry = current_time + int(data['expires_in'])
                print("[BIHR] Token obtained")
                return self.token
            else:
                print(f"[BIHR ERROR] Token request failed: {response.status_code} {response.text}")
        except Exception as e:
            print(f"[BIHR ERROR] {e}")
        return None

    def download_image(self, product_id, sku, product_code):
        if not product_code:
            return None, 'no_product_code'

        try:
            token = self.get_bihr_token()
            if token == 'mock_token':
                return self.generate_placeholder(sku), 'placeholder'

            url = f"{BIHR_API_BASE}/api/v2.1/Products/Image/{product_code}"
            headers = {'Authorization': f'Bearer {token}'}

            response = requests.get(url, headers=headers, timeout=30)
            if response.ok and response.content:
                return response.content, 'downloaded'
            elif response.status_code == 404:
                return None, 'not_found_on_bihr'
            else:
                return None, f'bihr_error_{response.status_code}'
        except Exception as e:
            return None, f'download_error_{e}'

    def generate_placeholder(self, sku):
        try:
            img = Image.new('RGB', (400, 400), color=(24, 24, 31))
            buffer = io.BytesIO()
            img.save(buffer, format='PNG')
            buffer.seek(0)
            return buffer.getvalue()
        except Exception as e:
            print(f"[ERROR] Generating placeholder for {sku}: {e}")
            return None

    def process_image(self, image_data, product_id, suffix):
        if not image_data:
            return None

        try:
            img = Image.open(io.BytesIO(image_data))
            if img.mode == 'RGBA':
                background = Image.new('RGB', img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            elif img.mode != 'RGB':
                img = img.convert('RGB')

            size = SIZES[suffix]
            resized = img.copy()
            resized.thumbnail(size, Image.Resampling.LANCZOS)

            buffer = io.BytesIO()
            resized.save(buffer, format='WEBP', quality=85, method=6)
            buffer.seek(0)

            filename = f"{product_id}-{suffix}.webp"
            filepath = os.path.join(UPLOADS_DIR, filename)

            with open(filepath, 'wb') as f:
                f.write(buffer.getvalue())

            if not os.path.exists(filepath):
                print(f"[ERROR] File not written: {filepath}")
                return None

            file_size = os.path.getsize(filepath)
            if file_size == 0:
                print(f"[ERROR] File is empty: {filepath}")
                os.remove(filepath)
                return None

            print(f"[OK] {filename} ({file_size} bytes)")
            return f"https://backendescapes.com/uploads/optimized/{filename}"

        except Exception as e:
            print(f"[ERROR] Processing {product_id}-{suffix}: {e}")
            return None

    def run(self, limit=None, start_offset=0):
        os.makedirs(UPLOADS_DIR, exist_ok=True)
        print(f"[INFO] UPLOADS_DIR: {UPLOADS_DIR}")
        print(f"[INFO] Dir exists: {os.path.isdir(UPLOADS_DIR)}")

        old_state = self.load_state()
        if old_state and old_state.get('current_id'):
            print(f"[INFO] Continuing from product_id: {old_state.get('current_id')}")

        conn = self.get_db_connection()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) as total FROM products WHERE status = 'published'")
            self.stats['total'] = cur.fetchone()['total']

        self.stats['start_time'] = datetime.now().isoformat()
        self.stats['status'] = 'running'

        offset = start_offset

        while self.running:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, sku, name, images, supplier_code
                    FROM products
                    WHERE status = 'published'
                      AND (images IS NULL OR images = '[]'::jsonb OR images::text NOT LIKE '%%api.mybihr.com%%')
                    ORDER BY id
                    LIMIT %s OFFSET %s
                """, (self.batch_size, offset))
                products = cur.fetchall()

            if not products:
                print("[DONE] No products to process")
                break

            for product in products:
                if not self.running:
                    break

                product_id = product['id']
                sku = product['sku'] or ''
                supplier_code = product.get('supplier_code', '') or ''
                product_name = product.get('name', '') or sku

                self.stats['current_id'] = product_id
                self.stats['processed'] += 1

                clean_sku = sku.replace('Aplicaciones:', '').replace('Applications:', '').strip()
                if not clean_sku and not supplier_code:
                    self.stats['skipped'] += 1
                    continue

                image_data, dl_status = self.download_image(product_id, clean_sku, supplier_code)

                if dl_status == 'placeholder':
                    print(f"[PLACEHOLDER] {product_id} - {clean_sku or supplier_code}")
                    self.stats['skipped'] += 1
                    continue

                if not image_data:
                    print(f"[SKIP] {product_id} - no image ({dl_status})")
                    self.stats['skipped'] += 1
                    continue

                processed_urls = {}
                all_ok = True

                for suffix in SIZES.keys():
                    url = self.process_image(image_data, product_id, suffix)
                    if url:
                        processed_urls[suffix] = url
                    else:
                        all_ok = False
                        break

                if all_ok and len(processed_urls) == 4:
                    images_json = json.dumps([{
                        'src': processed_urls.get('desktop', ''),
                        'srcMobile': processed_urls.get('mobile', ''),
                        'srcCardDesktop': processed_urls.get('card-desktop', ''),
                        'srcCardMobile': processed_urls.get('card-mobile', ''),
                        'alt': product_name
                    }])

                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE products SET images = %s WHERE id = %s",
                            (images_json, product_id)
                        )
                    conn.commit()
                    self.stats['success'] += 1
                    print(f"[SUCCESS] {product_id} - {clean_sku} - updated in BD")
                else:
                    self.stats['failed'] += 1
                    print(f"[FAILED] {product_id} - only {len(processed_urls)}/4 sizes generated")

                if self.stats['processed'] % 10 == 0:
                    self.save_state()

                time.sleep(self.delay_between)

            offset += self.batch_size

            if limit and offset >= limit:
                print(f"[LIMIT] Reached offset {offset} >= limit {limit}")
                break

        self.stats['status'] = 'completed' if self.running else 'paused'
        self.save_state()
        conn.close()

        return self.stats


def main():
    parser = argparse.ArgumentParser(description='Regenerate product images from Bihr')
    parser.add_argument('--limit', type=int, default=None, help='Max products to process')
    parser.add_argument('--offset', type=int, default=0, help='Starting offset')
    parser.add_argument('--batch', type=int, default=50, help='Batch size')
    parser.add_argument('--delay', type=float, default=0.5, help='Delay between requests')
    args = parser.parse_args()

    print(f"[START] regenerate_images.py --limit {args.limit} --batch {args.batch} --delay {args.delay}")

    regenerator = ImageRegenerator(batch_size=args.batch, delay_between=args.delay)
    stats = regenerator.run(limit=args.limit, start_offset=args.offset)

    print(f"\n[SUMMARY]")
    print(f"Total products: {stats['total']}")
    print(f"Processed: {stats['processed']}")
    print(f"Success: {stats['success']}")
    print(f"Failed: {stats['failed']}")
    print(f"Skipped: {stats['skipped']}")
    print(f"Status: {stats['status']}")


if __name__ == '__main__':
    main()