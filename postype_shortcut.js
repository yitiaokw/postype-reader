(async () => {
  try {
    const cleanText = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+\n/g, '\n').trim();

    /* 1. 定位 Postype 正文容器 */
    const container =
      document.querySelector('#post-content') ||
      document.querySelector('.post-content') ||
      document.querySelector('article');

    if (!container) {
      completion(JSON.stringify({
        _app: 'postype-local-reader',
        error: '未找到正文容器，请确认 Postype 文章已完整加载。'
      }));
      return;
    }

    /* 2. 提取标题与作者 */
    const getMeta = (sel) => {
      const m = document.querySelector(sel);
      return m && m.getAttribute('content') ? m.getAttribute('content').trim() : '';
    };
    const pickFirst = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && cleanText(el.innerText)) return cleanText(el.innerText);
      }
      return '';
    };

    let title = pickFirst(['h1.post-title', 'h1[class*="title"]', 'main h1', 'header h1', 'h1']);
    if (!title) {
      title = (getMeta('meta[property="og:title"]') || document.title || '未命名文章')
        .replace(/\s*[-|:]\s*(Postype|포스타입).*$/i, '')
        .trim();
    }

    let author = pickFirst([
      'a[class*="blog-title"]',
      '[class*="blog-title"]',
      '[class*="channel-name"]',
      '[class*="author-name"]',
      'a[href*="/@"]'
    ]);
    if (!author) author = getMeta('meta[name="author"]');
    if (!author) {
      const parts = (document.title || '').split(/\s+-\s+/);
      if (parts.length >= 2) author = parts[parts.length - 2].trim();
    }
    if (!author) author = '未知作者';

    /* 规范化文章链接，保证中韩两次抓取精准对齐合并 */
    const sourceUrl = location.origin + location.pathname.replace(/\/+$/, '');
    const postIdMatch = location.pathname.match(/\/(?:post|view)\/(\d+)/);
    const postId = postIdMatch ? postIdMatch[1] : '';

    /* 3. 插图本地压缩（最大宽 1100px，JPG 0.78，带超时和跨域兜底） */
    const compressImage = async (url) => {
      if (!url || url.startsWith('data:')) return { dataUrl: url || '', offline: Boolean(url) };
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        const resp = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) throw new Error('http');
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const img = new Image();
          const objUrl = URL.createObjectURL(blob);
          img.onload = () => {
            try {
              const maxW = 1100;
              let w = img.naturalWidth || img.width;
              let h = img.naturalHeight || img.height;
              if (w > maxW) {
                h = Math.round((h * maxW) / w);
                w = maxW;
              }
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#FFFFFF';
              ctx.fillRect(0, 0, w, h);
              ctx.drawImage(img, 0, 0, w, h);
              const out = canvas.toDataURL('image/jpeg', 0.78);
              URL.revokeObjectURL(objUrl);
              resolve(out);
            } catch (e) {
              URL.revokeObjectURL(objUrl);
              reject(e);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(objUrl);
            reject(new Error('img'));
          };
          img.src = objUrl;
        });
        return { dataUrl, offline: true };
      } catch (_) {
        return { dataUrl: '', offline: false };
      }
    };

    /* 4. 顺序读取段落、分割线与插图，保留 data-pid 与 data-sort */
    const blocks = [];
    const seenImgs = new Set();
    let imgCompressBudget = 12;
    let seq = 0;

    const getImgSrc = (img) =>
      img.currentSrc ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('src') ||
      '';

    const pushImage = async (imgEl, parentPid, parentSort) => {
      const src = getImgSrc(imgEl);
      if (!src || seenImgs.has(src)) return;
      const rect = imgEl.getBoundingClientRect ? imgEl.getBoundingClientRect() : { width: 100, height: 100 };
      if ((imgEl.naturalWidth && imgEl.naturalWidth < 36) || (rect.width > 0 && rect.width < 36 && rect.height < 36)) {
        return;
      }
      seenImgs.add(src);
      let imgData = '';
      let offline = false;
      if (imgCompressBudget > 0) {
        imgCompressBudget--;
        const res = await compressImage(src);
        imgData = res.dataUrl;
        offline = res.offline;
      }
      blocks.push({
        pid: parentPid ? parentPid + '_img_' + seq : 'img_' + seq,
        sort: parentSort || String(seq),
        type: 'img',
        imgData,
        imgSrc: src,
        offline
      });
      seq++;
    };

    const nodes = container.querySelectorAll('p, h1, h2, h3, h4, blockquote, hr, img');
    const handledImgs = new Set();

    for (const el of nodes) {
      const tag = el.tagName;
      if (tag === 'IMG') {
        if (handledImgs.has(el)) continue;
        const wrap = el.closest('[data-pid]');
        await pushImage(el, wrap ? (wrap.getAttribute('data-pid') || '') : '', wrap ? (wrap.getAttribute('data-sort') || '') : '');
        continue;
      }

      if (tag === 'HR') {
        blocks.push({
          pid: el.getAttribute('data-pid') || 'hr_' + seq,
          sort: el.getAttribute('data-sort') || String(seq),
          type: 'hr'
        });
        seq++;
        continue;
      }

      if (tag === 'P' && el.closest('blockquote') && !el.getAttribute('data-pid')) continue;

      const pid = el.getAttribute('data-pid') || ('p_' + seq);
      const sort = el.getAttribute('data-sort') || String(seq);

      const innerImgs = el.querySelectorAll('img');
      for (const im of innerImgs) {
        handledImgs.add(im);
        await pushImage(im, pid, sort);
      }

      const text = cleanText(el.innerText);
      if (!text) continue;

      blocks.push({
        pid,
        sort,
        type: tag === 'BLOCKQUOTE' ? 'quote' : /^H[1-4]$/.test(tag) ? 'heading' : 'p',
        text
      });
      seq++;
    }

    /* 5. 自动识别当前页面是中文译版还是韩文原版 */
    const allText = blocks.map((b) => b.text || '').join('');
    const zhCount = (allText.match(/[\u4e00-\u9fff]/g) || []).length;
    const koCount = (allText.match(/[\uac00-\ud7a3]/g) || []).length;
    const lang = koCount > zhCount * 1.2 ? 'ko' : 'zh';

    completion(JSON.stringify({
      _app: 'postype-local-reader',
      version: 1,
      extractedAt: Date.now(),
      lang,
      postId,
      sourceUrl,
      title,
      author,
      blocks
    }));
  } catch (err) {
    completion(JSON.stringify({
      _app: 'postype-local-reader',
      error: '提取出错：' + (err && err.message ? err.message : String(err))
    }));
  }
})();
