import { Router } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { parseIntSafe } from '../utils.js';

export const ordersRouter = Router();

export async function createInvoiceForOrder(orderId: number) {
  const existingInv = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
  if (existingInv.rows.length > 0) {
    return existingInv.rows[0];
  }

  const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${orderId}`);
  const order = orderRes.rows[0] as any;
  if (!order) throw new Error('Pedido no encontrado');

  const year = new Date().getFullYear();
  const countRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM invoices WHERE issued_at >= date_trunc('year', NOW())`);
  const cntVal = countRes?.rows?.[0] ? Number((countRes.rows[0] as any).cnt || (countRes.rows[0] as any).count || 0) : 0;
  const seqNum = String(cntVal + 1).padStart(6, '0');
  const invoiceNumber = `EYMAS-${year}-${seqNum}`;

  const itemsRes = await db.execute(sql`
    SELECT oi.*, p.name as product_name
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ${orderId}
  `);
  const items = itemsRes.rows as any[];

  const shippingData = (() => { try { return JSON.parse(order.shipping_data || '{}'); } catch { return {}; } })();
  const subtotal = order.subtotal || order.total || 0;
  const shippingCost = order.shipping_cost || 0;
  const discountAmount = order.discount_amount || 0;
  const totalCents = order.total || 0;

  let calculatedCostTotal = 0;
  for (const item of items) {
    const pCostRes = await db.execute(sql`SELECT cost FROM products WHERE id = ${item.product_id}`);
    const costVal = pCostRes.rows[0] ? (pCostRes.rows[0] as any).cost || 0 : 0;
    calculatedCostTotal += costVal * (item.quantity || 1);
  }
  
  if (calculatedCostTotal > 0 && (!order.cost_total || order.cost_total === 0)) {
    await db.execute(sql`UPDATE orders SET cost_total = ${calculatedCostTotal} WHERE id = ${orderId}`);
  }

  const taxAmount = Math.round(totalCents * 21 / 121);

  const invoicesDir = path.join(process.cwd(), 'invoices');
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });
  const pdfFileName = `${invoiceNumber}.pdf`;
  const pdfPath = path.join(invoicesDir, pdfFileName);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    doc.fontSize(22).font('Helvetica-Bold').text('ESCAPES Y MÁS', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#666666')
      .text('info@escapesymas.com  |  www.escapesymas.com', 50, 78)
      .text('CIF: B-XXXXXXXX  |  Dirección fiscal: C/ Ejemplo 1, 28001 Madrid', 50, 90);

    doc.fillColor('#FF6B00').roundedRect(400, 45, 145, 55, 4).fill();
    doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
      .text('FACTURA', 415, 55)
      .fontSize(10).font('Helvetica')
      .text(invoiceNumber, 415, 72)
      .text(new Date().toLocaleDateString('es-ES'), 415, 86);

    doc.fillColor('#000000');
    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#EEEEEE').lineWidth(1).stroke();

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('FACTURAR A:', 50, 130);
    doc.fontSize(10).font('Helvetica').fillColor('#000000')
      .text(`${shippingData.firstName || ''} ${shippingData.lastName || ''}`, 50, 145)
      .text(shippingData.email || '', 50, 158)
      .text(shippingData.address || '', 50, 171)
      .text(`${shippingData.city || ''} ${shippingData.postcode || ''} ${shippingData.country || ''}`, 50, 184);

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('PEDIDO Nº:', 350, 130);
    doc.fontSize(10).font('Helvetica').fillColor('#000000')
      .text(`#${order.id}`, 350, 145)
      .text(new Date(order.created_at || order.createdAt).toLocaleDateString('es-ES'), 350, 158);

    const tableTop = 220;
    doc.fillColor('#1A1A1A').rect(50, tableTop, 495, 20).fill();
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
      .text('DESCRIPCIÓN', 58, tableTop + 6)
      .text('CANT.', 370, tableTop + 6)
      .text('PRECIO UNIT.', 410, tableTop + 6)
      .text('TOTAL', 475, tableTop + 6);

    doc.fillColor('#000000');
    let yPos = tableTop + 28;
    let lineNum = 0;

    for (const item of items) {
      if (lineNum % 2 === 0) {
        doc.fillColor('#F9F9F9').rect(50, yPos - 4, 495, 18).fill();
      }
      const unitPrice = ((item.price || 0) / 100).toFixed(2);
      const lineTotal = (((item.price || 0) * (item.quantity || 1)) / 100).toFixed(2);
      doc.fillColor('#222222').fontSize(9).font('Helvetica')
        .text(item.product_name || item.name || 'Producto', 58, yPos, { width: 300 })
        .text(String(item.quantity || 1), 380, yPos)
        .text(`${unitPrice}€`, 415, yPos)
        .text(`${lineTotal}€`, 472, yPos);
      yPos += 20;
      lineNum++;
    }

    yPos += 10;
    doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#EEEEEE').lineWidth(0.5).stroke();
    yPos += 12;

    const totalBlock = (label: string, val: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .fillColor(bold ? '#FF6B00' : '#333333')
        .text(label, 350, yPos)
        .text(val, 472, yPos);
      yPos += bold ? 18 : 16;
    };

    if (discountAmount > 0) totalBlock('Descuento:', `-${(discountAmount / 100).toFixed(2)}€`);
    if (shippingCost > 0) totalBlock('Envío:', `${(shippingCost / 100).toFixed(2)}€`);
    totalBlock('Base imponible:', `${((totalCents - taxAmount) / 100).toFixed(2)}€`);
    totalBlock('IVA (21%):', `${(taxAmount / 100).toFixed(2)}€`);
    totalBlock('TOTAL:', `${(totalCents / 100).toFixed(2)}€`, true);

    doc.fontSize(7).fillColor('#AAAAAA')
      .text('Gracias por tu confianza en Escapes y Más. Esta factura es el documento legal de tu compra.', 50, 760, { align: 'center', width: 495 });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  try {
    await db.execute(sql`
      INSERT INTO invoices (order_id, invoice_number, subtotal, tax_amount, shipping_cost, discount_amount, total, pdf_path)
      VALUES (${orderId}, ${invoiceNumber}, ${subtotal}, ${taxAmount}, ${shippingCost}, ${discountAmount}, ${totalCents}, ${pdfPath})
    `);
  } catch (err: any) {
    if (err.code === '23505') {
      const dup = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
      return dup.rows[0];
    }
    throw err;
  }

  const invRes = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
  return invRes.rows[0];
}

// GET /api/orders
ordersRouter.get('/orders', async (req, res) => {
  try {
    const { userId, email, status } = req.query as any;
    if (!userId && !email) return res.status(400).json({ error: 'Falta userId o email' });

    const conditions = sql`WHERE 1=1`;
    if (status && status !== 'all') {
      conditions.append(sql` AND status = ${status}`);
    }
    if (userId) {
      const safeUserId = parseIntSafe(userId);
      if (!safeUserId) return res.status(400).json({ error: 'userId inválido' });
      conditions.append(sql` AND user_id = ${safeUserId}`);
    } else if (email) {
      conditions.append(sql` AND shipping_data->>'email' = ${email}`);
    }

    conditions.append(sql` ORDER BY created_at DESC LIMIT 5`);

    const ordersRes = await db.execute(sql`SELECT * FROM orders ${conditions}`);
    const result = ordersRes.rows.map((row: any) => {
      let shippingDataObj = {};
      try {
        shippingDataObj = typeof row.shipping_data === 'string' ? JSON.parse(row.shipping_data) : row.shipping_data;
      } catch (e) {}

      return {
        id: row.id,
        status: row.status,
        total: row.total / 100,
        payment_method: 'card',
        billing: shippingDataObj,
        created_at: row.created_at || row.createdAt
      };
    });

    return res.json(result);
  } catch (err: any) {
    console.error('[ORDERS GET ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/download-invoice
ordersRouter.get('/orders/download-invoice', async (req: any, res: any) => {
  const { orderId, userEmail } = req.query as any;
  if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

  try {
    const parsedId = parseInt(orderId, 10);
    if (isNaN(parsedId)) return res.status(400).json({ error: 'orderId inválido' });

    const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${parsedId}`);
    const order = orderRes.rows[0] as any;
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

    let isAuthorized = false;
    if (userEmail) {
      if (userEmail.toLowerCase() === 'info@escapesymas.com') {
        isAuthorized = true;
      } else {
        const uRes = await db.execute(sql`SELECT id FROM users WHERE email = ${userEmail}`);
        if (uRes.rows.length > 0 && uRes.rows[0].id === order.user_id) {
          isAuthorized = true;
        }
      }
    }

    if (!isAuthorized) {
      return res.status(401).json({ error: 'No autorizado para ver esta factura' });
    }

    const invRow = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${parsedId}`);
    if (!invRow.rows.length) {
      return res.status(404).json({ error: 'Factura no generada todavía.' });
    }

    const inv = invRow.rows[0] as any;
    const pdfFile = inv.pdf_path;

    if (!pdfFile || !fs.existsSync(pdfFile)) {
      return res.status(404).json({ error: 'Archivo PDF no encontrado en el servidor.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);
    fs.createReadStream(pdfFile).pipe(res);
  } catch (err: any) {
    console.error('[CUSTOMER INVOICE DOWNLOAD ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});
