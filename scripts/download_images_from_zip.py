#!/usr/bin/env python3
"""
Script para descargar imágenes de productos desde Bihr usando los CSVs del ZIP
"""

import os
import sys
import json
import time
import signal
import argparse
import zipfile
import csv
import io
from pathlib import Path
from urllib.parse import urlparse

import requests
import psycopg2
from psycopg2.extras import RealDictCursor
from PIL import Image
import io

# ================================================================
# CONFIGURACION
# ================================================================
BIHR_API_BASE = 'https://api.bihr.net'
BIHR_USERNAME = 'info@escapesymas.com'
BIHR_MACKEY = '3799B392-3934-4514-ABF0-9EF7F544A117'

DB_HOST = 'localhost'
DB_PORT = '5432'
DB_NAME = 'escapes_db'
DB_USER = 'postgres'
DB_PASSWORD = 'EscapesPostgres2026Vercel'

UPLOADS_DIR = '/var/www/vhosts/backendescapes.com/server/uploads/optimized'

SIZES = {
    'desktop': (800, 800),
    'mobile': (400, 400),
    'card-desktop': (400, 400),
    'card-mobile': (300, 300)
}

STATE_FILE = '/tmp/image_regen_state.json'

class ImageDownloader:
    def __init__(self, batch_size=20, delay_between=1.0):
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
            'current_sku': '',
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
        """Guarda el estado en PostgreSQL y como fallback en fichero local."""
        try:
            conn = psycopg2.connect(
                host=DB_HOST, port=DB_PORT, database=DB_NAME,
                user=DB_USER, password=DB_PASSWORD
            )
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE image_regen_state
                    SET status=%s, processed=%s, success=%s, failed=%s,
                        skipped=%s, total=%s, current_sku=%s, updated_at=NOW()
                    WHERE id=1
                """, (
                    self.stats.get('status', 'idle'),
                    self.stats.get('processed', 0),
                    self.stats.get('success', 0),
                    self.stats.get('failed', 0),
                    self.stats.get('skipped', 0),
                    self.stats.get('total', 0),
                    self.stats.get('current_sku', '')
                ))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"[STATE DB ERROR] {e} - falling back to file")
            # Fallback al fichero JSON legacy
            try:
                with open(STATE_FILE, 'w') as f:
                    json.dump(self.stats, f)
            except Exception as fe:
                print(f"[STATE FILE ERROR] {fe}")
    
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
                expires_in = int(data.get('expires_in', 3600))
                self.token_expiry = current_time + expires_in
                print("[BIHR] Token obtained")
                return self.token
        except Exception as e:
            print(f"[BIHR ERROR] {e}")
        return None
    
    def download_image_from_url(self, url):
        """Descarga imagen desde URL"""
        if not url or url == '':
            return None
        
        try:
            token = self.get_bihr_token()
            headers = {'Authorization': f'Bearer {token}'}
            
            # Convertir URL relativa a absoluta si es necesario
            if not url.startswith('http'):
                url = BIHR_API_BASE + url
            
            response = requests.get(url, headers=headers, timeout=30)
            if response.ok and response.content:
                return response.content
        except Exception as e:
            pass
        
        return None
    
    def process_image(self, image_data, sku):
        """Procesa imagen y genera versiones"""
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
            
            result = {}
            
            for suffix, size in SIZES.items():
                resized = img.copy()
                resized.thumbnail(size, Image.Resampling.LANCZOS)
                
                buffer = io.BytesIO()
                resized.save(buffer, format='WEBP', quality=85, method=6)
                buffer.seek(0)
                
                filename = f"{sku}-{suffix}.webp"
                filepath = os.path.join(UPLOADS_DIR, filename)
                
                with open(filepath, 'wb') as f:
                    f.write(buffer.getvalue())
                
                result[suffix] = f"https://backendescapes.com/uploads/optimized/{filename}"
            
            return result
            
        except Exception as e:
            print(f"[ERROR] Processing {sku}: {e}")
            return None
    
    def run_from_zip(self, zip_path, limit=None):
        """Descarga imágenes desde el ZIP de Bihr"""
        os.makedirs(UPLOADS_DIR, exist_ok=True)
        
        self.stats['status'] = 'running'
        self.stats['start_time'] = time.strftime('%Y-%m-%d %H:%M:%S')
        
        # Abrir el ZIP
        with zipfile.ZipFile(zip_path, 'r') as z:
            csv_files = [f for f in z.namelist() if f.endswith('.csv')]
            print(f"[INFO] Found {len(csv_files)} CSV files in ZIP")
            
            for csv_file in csv_files:
                if not self.running:
                    break
                
                print(f"[INFO] Processing {csv_file}...")
                
                with z.open(csv_file) as f:
                    # Leer CSV
                    text = f.read().decode('utf-8', errors='ignore')
                    reader = csv.DictReader(io.StringIO(text))
                    
                    for row in reader:
                        if not self.running:
                            break
                        if limit and self.stats['processed'] >= limit:
                            break
                        
                        # Obtener SKU y URLs de imágenes
                        sku = row.get('PartNumber', '').strip() or row.get('SupplierProductCode', '').strip()
                        if not sku:
                            continue
                        
                        self.stats['current_sku'] = sku
                        self.stats['processed'] += 1
                        
                        # Buscar URL de imagen (Picture1, Picture2, etc.)
                        image_url = row.get('Picture1', '').strip()
                        
                        if not image_url:
                            self.stats['skipped'] += 1
                            continue
                        
                        # Descargar imagen
                        image_data = self.download_image_from_url(image_url)
                        
                        if image_data:
                            processed = self.process_image(image_data, sku)
                            if processed:
                                # Actualizar base de datos
                                images_json = json.dumps([{
                                    'src': processed.get('desktop', ''),
                                    'srcMobile': processed.get('mobile', ''),
                                    'srcCardDesktop': processed.get('card-desktop', ''),
                                    'srcCardMobile': processed.get('card-mobile', ''),
                                    'alt': row.get('ProductName', '')[:100]
                                }])
                                
                                try:
                                    conn = self.get_db_connection()
                                    with conn.cursor() as cur:
                                        cur.execute(
                                            "UPDATE products SET images = %s WHERE sku = %s",
                                            (images_json, sku)
                                        )
                                    conn.commit()
                                    conn.close()
                                    self.stats['success'] += 1
                                except Exception as e:
                                    print(f"[DB ERROR] {e}")
                                    self.stats['failed'] += 1
                            else:
                                self.stats['failed'] += 1
                        else:
                            self.stats['skipped'] += 1
                        
                        if self.stats['processed'] % 10 == 0:
                            self.save_state()
                        
                        time.sleep(self.delay_between)
        
        self.stats['status'] = 'completed'
        self.save_state()
        
        return self.stats


def main():
    parser = argparse.ArgumentParser(description='Download images from Bihr ZIP')
    parser.add_argument('--zip', type=str, required=True, help='Path to Bihr ZIP file')
    parser.add_argument('--limit', type=int, default=None, help='Max products to process')
    parser.add_argument('--batch', type=int, default=20, help='Batch size')
    parser.add_argument('--delay', type=float, default=1.0, help='Delay between requests')
    args = parser.parse_args()
    
    downloader = ImageDownloader(batch_size=args.batch, delay_between=args.delay)
    stats = downloader.run_from_zip(args.zip, limit=args.limit)
    
    print(f"\n[SUMMARY]")
    print(f"Total: {stats['total']}")
    print(f"Processed: {stats['processed']}")
    print(f"Success: {stats['success']}")
    print(f"Failed: {stats['failed']}")
    print(f"Skipped: {stats['skipped']}")


if __name__ == '__main__':
    main()