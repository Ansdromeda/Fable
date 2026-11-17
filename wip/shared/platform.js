/* ---------- platform helpers: the page runs inside the Claude artifact viewer AND on any static host ----------
   Paste this block (as-is) near the top of the page's inline <script>. */
const Platform = (() => {
  const inViewer = typeof window.claude?.use === 'function';   // true only inside the artifact viewer
  let dl = null;
  const downloads = () => {
    if (!inViewer) return Promise.resolve(null);
    if (!dl) dl = Promise.resolve().then(() => window.claude.use('downloads')).catch(() => null);
    return dl;
  };
  if (inViewer) downloads();   // warm up; resolves later, null when this view cannot save files

  // Offer a generated file. Resolves 'saved' | 'declined' | 'manual'.
  // 'manual' means: no way to hand over a file here, so the CALLER must show the content as selectable text with a Copy button.
  // In the viewer only these extensions are accepted: txt json md csv html svg pdf png jpg zip xlsx docx.
  async function saveFile(filename, data, mime) {
    const cap = await downloads();
    if (cap) {
      try { await cap.save({ filename, data }); return 'saved'; }
      catch (e) { if (e && e.code === 'declined') return 'declined'; return 'manual'; }
    }
    if (inViewer) return 'manual';
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'saved';
  }

  // Copy text from inside a click handler. Returns true on success; on false, select the text for the user instead.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  // Browser storage that never throws (private windows, blocked site data, previews).
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };

  const canPrint = !inViewer;   // window.print() does nothing inside the viewer: hide Print buttons there, offer a downloadable .html report instead
  return { inViewer, saveFile, copyText, store, canPrint };
})();
