(function() {
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = 'r11-1791346799';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const title = (s) => {
    document.title = 'SMOKE|' + s;
    fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)).catch(() => {});
  };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(100); }
    return null;
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  (async () => {
    try {
      title('r11-opening');
      const ses = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return (ss || []).find((s) => s.state === 'Connected');
      }, 150);
      if (!ses) { title('FAIL-no-session'); return; }
      const sid = ses.id;
      title('r11-session|' + sid);
      const row = await waitFor(async () => document.querySelector('.card.row div[title]'), 50);
      if (!row) { title('FAIL-no-row'); return; }
      row.click();
      const term = await waitFor(async () => (window.__t_terms && window.__t_terms.get(sid)) || null, 100);
      if (!term) { title('FAIL-no-term'); return; }
      await sleep(800);
      title('r11-attached');
      const dbg = await inv('debug_subscriptions', {});
      const mine = (dbg.per_session || []).find((p) => p.session_id === sid);
      mark('r11-subs|active=' + dbg.active_count + '|mine=' + (mine ? mine.subscription_ids.length : 0));
      if (!mine || mine.subscription_ids.length !== 1) { title('FAIL-subs|' + JSON.stringify(dbg).slice(0, 160)); return; }
      const sub = mine.subscription_ids[0];
      let resyncCount = 0;
      window.addEventListener('resync', () => { resyncCount += 1; });
      mark('r11-flood-begin');
      await inv('send_keys', { sid, keys: "printf 'B11-BEGIN\\n'; seq 1 3000; printf 'B11-END\\n'\r" });
      const bufText = () => {
        const b = term.buffer.active;
        let out = '';
        for (let i = 0; i < b.length; i++) { out += (b.getLine(i) ? b.getLine(i).translateToString(true) : '') + '\n'; }
        return out;
      };
      let ok = false;
      for (let i = 0; i < 100; i++) { if (bufText().includes('B11-END')) { ok = true; break; } await sleep(100); }
      if (!ok) { title('FAIL-flood-timeout'); return; }
      await sleep(500);
      const bt = bufText();
      // 整行匹配：PTY 会回显命令行本身（内含标记子串），substring 计数会双计
      const standalone = (s) => bt.split('\n').filter((l) => l.trim() === s).length;
      const beginN = standalone('B11-BEGIN');
      const endN = standalone('B11-END');
      const numLines = bt.split('\n').filter((l) => /^\s*(\d+)\s*$/.test(l)).map((l) => parseInt(l, 10));
      const uniq = new Set(numLines);
      let missing = 0;
      for (let i = 1; i <= 3000; i++) { if (!uniq.has(i)) missing++; }
      const dup = numLines.length - uniq.size;
      mark('r11-flood|begin=' + beginN + '|end=' + endN + '|missing=' + missing + '|dup=' + dup + '|resync=' + resyncCount);
      if (beginN !== 1 || endN !== 1 || missing !== 0 || dup !== 0 || resyncCount !== 0) {
        title('FAIL-flood|' + beginN + ',' + endN + ',' + missing + ',' + dup + ',' + resyncCount);
        return;
      }
      title('r11-flood-ok');
      let expiredRejected = false;
      try { await inv('resync_output', { sid, subscriptionId: 'sub-bogus', fromSeq: 1 }); } catch (e) { expiredRejected = true; }
      if (!expiredRejected) { title('FAIL-expired-accepted'); return; }
      const rs = await inv('resync_output', { sid, subscriptionId: sub, fromSeq: null });
      if (!rs || !rs.kind || (rs.kind !== 'checkpointed' && rs.kind !== 'replayed')) {
        title('FAIL-resync-shape|' + JSON.stringify(rs).slice(0, 120));
        return;
      }
      mark('r11-resync|kind=' + rs.kind + '|end=' + rs.end_seq);
      title('r11-resync-ok');
      await inv('send_keys', { sid, keys: "printf '\\033[?1049h\\033[HALT-MARK-7Q'\r" });
      await sleep(700);
      const rs2 = await inv('resync_output', { sid, subscriptionId: sub, fromSeq: null });
      const ab = rs2 && rs2.checkpoint ? rs2.checkpoint.active_buffer : -1;
      const altText = rs2 && rs2.checkpoint ? JSON.stringify(rs2.checkpoint.buffers[1]) : '';
      mark('r11-alt|buffer=' + ab + '|has=' + altText.includes('ALT-MARK-7Q'));
      if (ab !== 1 || !altText.includes('ALT-MARK-7Q')) { title('FAIL-alt|' + ab); return; }
      await inv('send_keys', { sid, keys: "printf '\\033[?1049l'\r" });
      await sleep(300);
      title('r11-alt-ok');
      await inv('unsubscribe_output', { sid, subscriptionId: sub });
      const dbg2 = await inv('debug_subscriptions', {});
      const mine2 = (dbg2.per_session || []).find((p) => p.session_id === sid);
      const left = mine2 ? mine2.subscription_ids.length : 0;
      mark('r11-unsub|left=' + left + '|active=' + dbg2.active_count);
      if (left !== 0) { title('FAIL-unsub|' + left); return; }
      await inv('unsubscribe_output', { sid, subscriptionId: sub });
      title('r11-DONE');
    } catch (e) {
      title('FAIL|' + e);
    }
  })();
})();