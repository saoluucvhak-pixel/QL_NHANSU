'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientEnv } = require('./mocks/client-env.js');

/* =========================================================================
   esc / tagClass — hàm hiển thị thuần
   ========================================================================= */
test('esc: escape đúng các ký tự HTML nguy hiểm (chống XSS khi render innerHTML)', () => {
  const env = createClientEnv();
  assert.equal(env.context.esc('<script>a&"b</script>'), '&lt;script&gt;a&amp;&quot;b&lt;/script&gt;');
  assert.equal(env.context.esc(undefined), '');
  assert.equal(env.context.esc(null), '');
  assert.equal(env.context.esc(0), '0');
});

test('tagClass: phân loại đúng màu tag theo trạng thái tiếng Việt', () => {
  const env = createClientEnv();
  assert.equal(env.context.tagClass('Đang làm việc'), 'tag-green');
  assert.equal(env.context.tagClass('Đã duyệt'), 'tag-green');
  assert.equal(env.context.tagClass('Chờ duyệt'), 'tag-amber');
  assert.equal(env.context.tagClass('Nghỉ việc'), 'tag-red');
  assert.equal(env.context.tagClass('Hủy'), 'tag-red');
  assert.equal(env.context.tagClass('gì đó lạ'), 'tag-grey');
});

/* =========================================================================
   fieldDisplay / refLabelsJoined
   ========================================================================= */
test('fieldDisplay: tra đúng nhãn cho field kiểu select tham chiếu bảng khác', () => {
  const env = createClientEnv();
  env.setData({ DM_PHONGBAN: [{ _id: 'pb1', TenPB: 'Kinh doanh' }] });
  const field = { type: 'select', refTable: 'DM_PHONGBAN', refLabel: 'TenPB' };
  assert.equal(env.context.fieldDisplay(field, 'pb1'), 'Kinh doanh');
  assert.equal(env.context.fieldDisplay(field, 'khong-ton-tai'), 'khong-ton-tai', 'không tìm thấy ref thì trả lại value gốc');
  assert.equal(env.context.fieldDisplay(field, ''), '—', 'rỗng hiển thị gạch ngang');
});

test('fieldDisplay: multiselect nối đúng nhiều nhãn tham chiếu, field money/percent định dạng đúng', () => {
  const env = createClientEnv();
  env.setData({ DM_HOTRO: [{ _id: 'ht1', TenHoTro: 'Tiền cơm' }, { _id: 'ht2', TenHoTro: 'Xăng xe' }] });
  const multi = { type: 'multiselect', refTable: 'DM_HOTRO', refLabel: 'TenHoTro' };
  assert.equal(env.context.fieldDisplay(multi, 'ht1,ht2'), 'Tiền cơm, Xăng xe');

  assert.equal(env.context.fieldDisplay({ money: true }, 4680000), '4.680.000 đ');
  assert.equal(env.context.fieldDisplay({ percent: true }, 0.175), '17,5%');
  assert.equal(env.context.fieldDisplay({ type: 'yesno' }, true), 'Có');
  assert.equal(env.context.fieldDisplay({ type: 'yesno' }, false), 'Không');
});

/* =========================================================================
   generateNextMaNV / generateNextSoHDLD / generateNextMaCongTac
   ========================================================================= */
test('generateNextMaNV: sinh đúng STT kế tiếp trong đúng nhóm Phòng ban + Chức vụ, không lẫn nhóm khác', () => {
  const env = createClientEnv();
  env.setData({
    DM_NHANVIEN: [
      { MaNV: '02.01.8.001' }, { MaNV: '02.01.8.002' },
      { MaNV: '02.01.9.001' },  // khác chức vụ (9 thay vì 8) -> không được tính vào nhóm 8
      { MaNV: '01.02.8.005' },  // khác phòng ban -> không được tính vào nhóm 02.01
    ],
  });
  assert.equal(env.context.generateNextMaNV('02.01', '8'), '02.01.8.003');
  assert.equal(env.context.generateNextMaNV('02.01', '9'), '02.01.9.002');
  assert.equal(env.context.generateNextMaNV('99.99', '1'), '99.99.1.001', 'nhóm chưa có ai thì bắt đầu từ 001');
});

test('generateNextMaCongTac: đếm đúng số phụ lục hiện có trong CÙNG 1 hợp đồng, không lẫn hợp đồng khác', () => {
  const env = createClientEnv();
  env.setData({
    CT_QUATRINHLAMVIEC: [{ _id: 'hd1', SoHDLD: 'HD-001' }],
    CT_CHITIETHOPDONG: [
      { _id: 'ct1', _parentId: 'hd1' },
      { _id: 'ct2', _parentId: 'hd1' },
      { _id: 'ct3', _parentId: 'hd-khac' },
    ],
  });
  assert.equal(env.context.generateNextMaCongTac('hd1'), 'HD-001-PL03');
  assert.equal(env.context.generateNextMaCongTac('hd-chua-co-phu-luc'), 'PL01', 'hợp đồng không tồn tại vẫn không lỗi, không có tiền tố Số HĐLĐ');
});

/* =========================================================================
   computeHeadcountReport — báo cáo tình hình nhân sự theo kỳ
   ========================================================================= */
test('computeHeadcountReport: lọc đúng nhân viên đang làm trong kỳ + đánh dấu tuyển mới/nghỉ việc trong kỳ', () => {
  const env = createClientEnv();
  env.setData({
    DM_NHANVIEN: [
      { _id: 'nv1', TenNhanVien: 'Còn làm việc', NgayVaoHeThong: '2020-01-01' },
      { _id: 'nv2', TenNhanVien: 'Tuyển mới trong kỳ', NgayVaoHeThong: '2020-01-01' },
      { _id: 'nv3', TenNhanVien: 'Đã nghỉ trước kỳ báo cáo', NgayVaoHeThong: '2020-01-01' },
      { _id: 'nv4', TenNhanVien: 'Vào làm sau kỳ báo cáo', NgayVaoHeThong: '2020-01-01' },
    ],
    CT_QUATRINHLAMVIEC: [
      { _id: 'hd1', _parentId: 'nv1', NgayVaoLam: '2020-01-01' },
      { _id: 'hd2', _parentId: 'nv2', NgayVaoLam: '2024-03-15' },
      { _id: 'hd3', _parentId: 'nv3', NgayVaoLam: '2019-01-01', NgayChamDutHDLD: '2023-12-31' },
      { _id: 'hd4', _parentId: 'nv4', NgayVaoLam: '2025-06-01' },
    ],
    CT_QUATRINHCONGTAC: [],
    DM_PHONGBAN: [], DM_CHUCVU: [],
  });

  const list = env.context.computeHeadcountReport('2024-01-01', '2024-12-31');
  // list/map/sort đều chạy trong "realm" của vm context — bọc lại bằng Array.from (thuộc realm của
  // Node/test) trước khi so deepEqual, tránh lỗi giả "same structure but not reference-equal" do
  // Array.prototype khác nhau giữa 2 realm chứ không phải do dữ liệu sai.
  const ids = Array.from(list.map(x => x.emp._id)).sort();
  assert.deepEqual(ids, ['nv1', 'nv2'], 'chỉ nv1 (đang làm xuyên suốt) và nv2 (tuyển mới trong kỳ) thuộc kỳ báo cáo');

  const nv2 = list.find(x => x.emp._id === 'nv2');
  assert.equal(nv2.tuyenMoiTrongKy, true);
  const nv1 = list.find(x => x.emp._id === 'nv1');
  assert.equal(nv1.tuyenMoiTrongKy, false);
});
