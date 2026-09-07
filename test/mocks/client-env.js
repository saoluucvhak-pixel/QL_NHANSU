'use strict';
/**
 * Môi trường giả lập tối thiểu để nạp TRỰC TIẾP phần <script> của JavaScript.html bằng Node (qua vm),
 * đủ để unit-test các hàm THUẦN TÍNH TOÁN (không đụng DOM) như fieldDisplay, generateNextMaNV,
 * computeHeadcountReport... File này chủ yếu vẽ UI (render/bindEvents thao tác DOM thật) nên chỉ cần
 * stub tối thiểu để toàn bộ script NẠP được (định nghĩa hàm) mà không ném lỗi ở top-level — các hàm
 * đụng DOM sẽ không được gọi trong test, chỉ các hàm thuần mới được gọi.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_HTML_PATH = path.join(__dirname, '..', '..', 'JavaScript.html');

function extractScriptBody(html) {
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  if (start === -1 || end === -1) throw new Error('Không tìm thấy thẻ <script> trong JavaScript.html');
  return html.slice(start + '<script>'.length, end);
}

/** 1 phần tử DOM giả dùng chung cho mọi getElementById/querySelector/createElement — file này chỉ
 *  cần KHÔNG NÉM LỖI khi loadAll() tự chạy ở cuối script và gọi render() (thất bại sớm vì "google"
 *  không tồn tại, nhưng nhánh xử lý lỗi của loadAll() vẫn render() ra màn hình lỗi) — không cần DOM
 *  thật vì các test ở đây chỉ gọi thẳng các hàm tính toán thuần, không gọi render()/bindEvents(). */
function makeFakeElement() {
  const el = {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, children: [], innerHTML: '', textContent: '', value: '',
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, remove() {}, focus() {}, click() {},
    querySelector() { return makeFakeElement(); },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  return el;
}

function createClientEnv() {
  const sandbox = {
    console,
    window: { addEventListener() {}, print() {}, dispatchEvent() {} },
    Event: function Event(type) { this.type = type; },
    document: {
      getElementById() { return makeFakeElement(); },
      querySelector() { return makeFakeElement(); },
      querySelectorAll() { return []; },
      addEventListener() {},
      createElement() { return makeFakeElement(); },
      body: { onclick: null },
    },
    navigator: {},
    location: { href: '' },
    requestAnimationFrame() { return 0; },
    // KHÔNG dùng setTimeout/clearTimeout thật của Node: nudgeResize() tự lặp lại bằng setTimeout để
    // "rung" chiều cao iframe — nếu để chạy thật, nó sẽ lặp mãi và đòi thêm hàng loạt API window/DOM
    // của trình duyệt (scrollBy, dispatchEvent...) không liên quan gì tới các hàm thuần cần test.
    setTimeout() { return 0; },
    clearTimeout() {},
  };
  const context = vm.createContext(sandbox);

  const html = fs.readFileSync(JS_HTML_PATH, 'utf8');
  const scriptBody = extractScriptBody(html);
  const expose = `
;globalThis.__EXPORTS__ = { TABLES };
globalThis.__setData__ = function(d){ DATA = d; };
globalThis.__getData__ = function(){ return DATA; };
`;
  vm.runInContext(scriptBody + '\n' + expose, context, { filename: 'JavaScript.html' });

  return {
    context,
    tables: context.__EXPORTS__.TABLES,
    setData(d) { context.__setData__(d); },
    getData() { return context.__getData__(); },
  };
}

module.exports = { createClientEnv };
