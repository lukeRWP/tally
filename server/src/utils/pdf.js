/**
 * Collect a pdfkit document into a single Buffer.
 *
 * Every PDF renderer (labels and reports alike) used to hand-roll the same
 * Promise + bufs + on('data') / on('end') / on('error') boilerplate; this is
 * that boilerplate, once. `draw` may be sync or async — the document is ended
 * only after it completes, and a throw/rejection rejects the returned promise
 * instead of leaving the stream dangling.
 */
function collectPdf(doc, draw) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
    // A sync draw runs to completion right here — deferring it (even by a
    // microtask) reorders pdfkit's async PNG-embed callbacks and permutes the
    // object write order, which broke the refactor's byte-for-byte guarantee.
    let result;
    try {
      result = draw();
    } catch (err) {
      return reject(err);
    }
    if (result && typeof result.then === 'function') result.then(() => doc.end(), reject);
    else doc.end();
  });
}

module.exports = { collectPdf };
