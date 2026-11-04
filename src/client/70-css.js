/* ===== 归属：Lead · 样式聚合 =====
 * 每个 client 片段自带一份 CSS_* 常量，这里按固定顺序拼成一张样式表，
 * 由 80-apply.js 注入到 <style data-plugin-css="flowpilot">。
 */

function fpPushCss(chunks, value) {
  if (typeof value === 'string' && value.trim() !== '') chunks.push(value);
}

function fpStyleSheet() {
  const chunks = [];
  let missing = [];
  const take = (name, read, fallback) => {
    try {
      const value = read();
      if (typeof value === 'string' && value.trim() !== '') chunks.push(value);
      else missing.push(name);
    } catch (error) {
      missing.push(name);
    }
  };
  take('CSS_BASE', () => CSS_BASE);
  take('CSS_PRIMITIVES', () => CSS_PRIMITIVES);
  take('CSS_SHELL', () => CSS_SHELL);
  take('CSS_FLOW', () => CSS_FLOW);
  take('CSS_VIEWS', () => CSS_VIEWS);
  take('CSS_AI', () => CSS_AI);
  take('CSS_SYNC', () => CSS_SYNC);
  take('CSS_UPDATE', () => CSS_UPDATE);
  take('CSS_QUICK', () => CSS_QUICK);
  if (missing.length > 0) {
    try {
      console.warn('[flowpilot] 缺少样式片段：' + missing.join(', '));
    } catch (error) {
      /* ignore */
    }
  }
  return chunks.join('\n');
}
