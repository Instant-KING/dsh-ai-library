const bases = ['https://api.dshmk.com/', 'https://api.dshmk.com/api/plugins', 'https://api.dshmk.com/plugins'];
for (const b of bases) {
  try {
    const r = await fetch(b, { headers: { 'user-agent': 'dsh-ai-library' } });
    const text = await r.text();
    console.log('  ' + b + ' → HTTP ' + r.status + ' | 长度 ' + text.length);
    if (r.ok) {
      const has = /ai-library|Instant-KING/.test(text);
      console.log('    含 ai-library? ' + has);
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : j.plugins || j.data || j.items || [];
        console.log('    条目数: ' + arr.length);
        if (arr.length) console.log('    样例键: ' + Object.keys(arr[0]).slice(0, 12).join(','));
      } catch { console.log('    (非 JSON)'); }
    }
  } catch (e) {
    console.log('  ' + b + ' → 失败: ' + String(e.message).slice(0, 60));
  }
}
