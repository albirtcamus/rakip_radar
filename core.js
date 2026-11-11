// core.js — isim ayıklama ve eşleştirme (kamera/ekran kodundan bağımsız)
(function (root) {
  'use strict';

  // OCR'ın sık karıştırdığı karakterleri tek bir karaktere indirger.
  const CONFUSE = { '0': 'o', '1': 'l', 'i': 'l', '|': 'l', '!': 'l', '5': 's', '$': 's', '8': 'b', '2': 'z', '9': 'g', 'q': 'g' };

  // Eşleştirme anahtarı: küçük harf, karışan harfler birleşik, _ - . ve boşluk yok.
  function normKey(s) {
    s = String(s || '').toLowerCase()
      .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
    let out = '';
    for (const ch of s) {
      const c = CONFUSE[ch] || ch;
      if (/[a-z0-9]/.test(c)) out += c;
    }
    return out;
  }

  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 0..1 arası benzerlik. Kesilmiş isimleri ("extrasolld3") ve sona yapışmış harfi ("...36a") tolere eder.
  function score(cand, key) {
    if (!cand || !key) return 0;
    let s = 1 - lev(cand, key) / Math.max(cand.length, key.length);
    if (cand.length >= Math.max(7, Math.ceil(key.length * 0.7)) && key.length > cand.length) {
      const pre = key.slice(0, cand.length);
      s = Math.max(s, (1 - lev(cand, pre) / cand.length) * 0.95);
    }
    if (cand.length > key.length && cand.length - key.length <= 2 && key.length >= 5) {
      s = Math.max(s, (1 - lev(cand.slice(0, key.length), key) / key.length) * 0.97);
    }
    return s;
  }

  function threshold(len) {
    if (len <= 4) return 1;
    if (len <= 6) return 0.85;
    return 0.8;
  }

  const STOP = /^(a|ad[a-zıi1l|!]*|dp|op|of|ap|vs|v5|ys|yas)$/i;
  const UI = new Set(['division', 'rivals', 'devam', 'ediyor', 'oyuna', 'davet', 'ayarlar', 'football', 'ultimate', 'team',
    'yer', 'acik', 'açık', 'oyuncu', 'oyuncuları', 'oyunculari', 'oyunculan', 'görüntüle', 'goruntule', 'istatistikler', 'kupalar',
    'yardimi', 'yardımı', 'oyun', 'rakibin', 'formasi', 'forması', 'squad', 'battles', 'champions', 'kendin', 'varsayilan']);

  function cleanTok(t) { return t.replace(/^[^A-Za-z0-9_\-]+|[^A-Za-z0-9_\-]+$/g, ''); }

  function isNickLike(t) {
    return /^[A-Za-z0-9_\-]{3,16}$/.test(t) && !STOP.test(t) && !UI.has(t.toLowerCase()) && /[A-Za-z]/.test(t);
  }

  function tokenize(text) {
    const lines = (text || '').split(/\n/).map(l => l.split(/[\s|]+/).map(cleanTok).filter(Boolean)).filter(l => l.length);
    return lines;
  }

  // Kareye düşen herhangi bir kelime listedeki biriyle eşleşiyor mu?
  function ownList(own) { return (Array.isArray(own) ? own : [own]).filter(Boolean).map(normKey).filter(Boolean); }

  // db: [{key, ...}] — her eleman bir isim veya öğrenilmiş yanlış okuma olabilir.
  function findKnown(text, db, own) {
    const owns = ownList(own);
    const cands = new Set();
    for (const line of tokenize(text)) {
      for (let i = 0; i < line.length; i++) {
        let joined = '';
        for (let j = i; j < Math.min(line.length, i + 3); j++) {
          joined += line[j];
          const k = normKey(joined);
          if (k.length >= 3) cands.add(k);
        }
      }
    }
    let best = null;
    for (const k of cands) {
      if (owns.some(o => score(k, o) >= 0.8)) continue;
      for (const r of db) {
        const s = score(k, r.key);
        if (s >= threshold(r.key.length) && (!best || s > best.score)) best = { rec: r, score: s, read: k };
      }
    }
    return best;
  }

  function isOwn(tok, own) {
    const k = normKey(tok);
    return ownList(own).some(o => score(k, o) >= 0.8);
  }

  // Ekrandaki metinden rakibin nickini çıkarır. Bulamazsa null.
  function extractOpponent(text, ownNick) {
    const lines = tokenize(text);
    const flat = [];
    lines.forEach((l, li) => l.forEach(t => flat.push({ t, li })));

    // Kural 1: "X adlı VS Y adlı" kartı
    const vsIdx = flat.findIndex(x => /^(vs|v5|ys|yas)$/i.test(x.t));
    if (vsIdx >= 0) {
      const right = [];
      for (let i = vsIdx + 1; i < flat.length && right.length < 3; i++) {
        const x = flat[i];
        if (right.length && x.li !== flat[i - 1].li) break;
        if (STOP.test(x.t)) { if (right.length) break; else continue; }
        right.push(x.t);
      }
      let left = null;
      for (let i = vsIdx - 1; i >= 0 && i >= vsIdx - 4; i--) {
        if (isNickLike(flat[i].t)) { left = flat[i].t; break; }
      }
      let r = right.join('_');
      if (right.length === 1) r = r.replace(/^(.{3,}?)ad[a-z1|!]{0,2}$/i, '$1').replace(/(\d)a$/, '$1');
      if (r && isNickLike(r.slice(0, 16)) && !isOwn(r, ownNick)) return r;
      if (left && !isOwn(left, ownNick) && r && isOwn(r, ownNick)) return left;
    }

    // Kural 2: oyuncu listesi — "Tüm Oyuncuları Görüntüle" satırının hemen üstü
    const raw = (text || '').split(/\n/).filter(l => l.trim());
    for (let i = 1; i < raw.length; i++) {
      if (/oyuncu\S*\s+g/i.test(raw[i])) {
        for (let back = 1; back <= 2 && i - back >= 0; back++) {
          const toks = raw[i - back].split(/[\s|]+/).map(cleanTok).filter(isNickLike).filter(t => !isOwn(t, ownNick));
          toks.sort((a, b) => b.length - a.length);
          if (toks[0] && toks[0].length >= 4) return toks[0];
        }
      }
    }
    return null;
  }

  root.Core = { VERSION: '2.1', normKey, lev, score, threshold, findKnown, extractOpponent, isOwn };
  if (typeof module !== 'undefined') module.exports = root.Core;
})(typeof self !== 'undefined' ? self : this);
