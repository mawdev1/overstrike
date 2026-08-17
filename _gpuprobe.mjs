import { chromium } from 'playwright';

async function probe(label, opts) {
  let browser;
  try {
    browser = await chromium.launch(opts);
    const page = await browser.newPage();
    await page.goto('about:blank');
    const info = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return { webgl2: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl2: true,
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
        maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      };
    });
    console.log(label, JSON.stringify(info));
  } catch (e) {
    console.log(label, 'ERROR', e.message.slice(0, 200));
  } finally { await browser?.close(); }
}

await probe('headless-default ', { headless: true });
await probe('headless-angle-d3d', { headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
await probe('headed-real-gpu   ', { headless: false, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--window-position=-4000,-4000'] });
