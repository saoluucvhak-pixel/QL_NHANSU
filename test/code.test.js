'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnv, createConfiguredGasEnv } = require('./mocks/gas-env.js');

/* =========================================================================
   0) TIỆN ÍCH THUẦN (không phụ thuộc Sheet)
   ========================================================================= */
test('extractSheetId_: lấy đúng ID từ URL Google Sheet, báo lỗi khi URL sai', () => {
  const env = createGasEnv();
  const id = env.context.extractSheetId_('https://docs.google.com/spreadsheets/d/ABC123_-xyz/edit#gid=0');
  assert.equal(id, 'ABC123_-xyz');
  assert.throws(() => env.context.extractSheetId_('không phải link sheet'), /không hợp lệ/);
});

test('uid_: sinh id duy nhất, đúng tiền tố "id_"', () => {
  const env = createGasEnv();
  const a = env.context.uid_(), b = env.context.uid_();
  assert.notEqual(a, b);
  assert.match(a, /^id_[a-f0-9]{12}$/);
});

/* =========================================================================
   1) CẤU HÌNH LIÊN KẾT (saveConfig / getConfigStatus / resetConfig)
   ========================================================================= */
test('saveConfig + getConfigStatus: roundtrip đúng 3 link', () => {
  const env = createConfiguredGasEnv();
  const status = env.context.getConfigStatus();
  assert.equal(status.configured, true);
  assert.equal(status.initialized, false);
  assert.match(status.congTyUrl, new RegExp(env.congTyId));
});

test('resetConfig: chỉ Admin được xoá cấu hình', () => {
  const env = createConfiguredGasEnv();
  env.setCurrentUser('nguoi-la@example.com');
  assert.throws(() => env.context.resetConfig(), /Chỉ Admin/);

  env.setCurrentUser('saoluucvhak@gmail.com'); // ADMIN_EMAIL, tự bootstrap thành Admin
  assert.equal(env.context.resetConfig(), true);
  assert.equal(env.context.getConfigStatus().configured, false);
});

/* =========================================================================
   2) PHÂN QUYỀN NGƯỜI DÙNG
   ========================================================================= */
test('getCurrentUserInfo: email lạ (chưa đăng ký) -> denied, có link đổi tài khoản', () => {
  const env = createConfiguredGasEnv();
  env.setCurrentUser('nguoi-la@example.com');
  const me = env.context.getCurrentUserInfo();
  assert.equal(me.denied, true);
  assert.equal(me.canAdmin, false);
  assert.ok(me.switchAccountUrl.includes('AccountChooser'));
});

test('getCurrentUserInfo: tài khoản bị khoá (TrangThai=Khóa) -> denied + locked=true', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo(); // bootstrap Admin (đang là user hiện tại -> đủ quyền tạo user khác)
  env.context.saveUserPermission({ Email: 'nv1@example.com', HoTen: 'NV 1', VaiTro: 'Nhân viên', TrangThai: 'Khóa' });
  env.setCurrentUser('nv1@example.com');
  const me = env.context.getCurrentUserInfo();
  assert.equal(me.denied, true);
  assert.equal(me.locked, true);
});

test('getCurrentUserInfo: ma trận quyền Admin / Quản lý / Nhân viên đúng thiết kế', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo(); // bootstrap Admin

  // Quản lý CÓ quyền duyệt
  env.context.saveUserPermission({ Email: 'ql-duyet@example.com', HoTen: 'QL Duyệt', VaiTro: 'Quản lý', ChoPhepDuyet: true, TrangThai: 'Hoạt động' });
  env.setCurrentUser('ql-duyet@example.com');
  let me = env.context.getCurrentUserInfo();
  assert.equal(me.canApprove, true);
  assert.equal(me.canAdmin, false);
  assert.equal(me.canManageUsers, true);

  // Quản lý KHÔNG có quyền duyệt
  env.setCurrentUser('saoluucvhak@gmail.com');
  env.context.saveUserPermission({ Email: 'ql-thuong@example.com', HoTen: 'QL Thường', VaiTro: 'Quản lý', ChoPhepDuyet: false, TrangThai: 'Hoạt động' });
  env.setCurrentUser('ql-thuong@example.com');
  me = env.context.getCurrentUserInfo();
  assert.equal(me.canApprove, false);

  // Nhân viên được cấp quyền thao tác
  env.setCurrentUser('saoluucvhak@gmail.com');
  env.context.saveUserPermission({ Email: 'nv-thaotac@example.com', HoTen: 'NV Thao tác', VaiTro: 'Nhân viên', ChoPhepThaoTac: true, TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv-thaotac@example.com');
  me = env.context.getCurrentUserInfo();
  assert.equal(me.canEdit, true);
  assert.equal(me.canApprove, false);
  assert.equal(me.canManageUsers, false);

  // Nhân viên thường (không quyền gì)
  env.setCurrentUser('saoluucvhak@gmail.com');
  env.context.saveUserPermission({ Email: 'nv-thuong@example.com', HoTen: 'NV Thường', VaiTro: 'Nhân viên', TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv-thuong@example.com');
  me = env.context.getCurrentUserInfo();
  assert.equal(me.canEdit, false);
  assert.equal(me.canApprove, false);
});

test('saveUserPermission: Quản lý chỉ được phân quyền cho Nhân viên, không được đụng vai trò khác', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo();
  env.context.saveUserPermission({ Email: 'ql1@example.com', HoTen: 'QL 1', VaiTro: 'Quản lý', TrangThai: 'Hoạt động' });
  env.setCurrentUser('ql1@example.com');
  assert.throws(
    () => env.context.saveUserPermission({ Email: 'ql2@example.com', HoTen: 'QL 2', VaiTro: 'Quản lý', TrangThai: 'Hoạt động' }),
    /chỉ được phân quyền cho Nhân viên/
  );
  // Nhưng vẫn tạo được Nhân viên
  assert.doesNotThrow(() => env.context.saveUserPermission({ Email: 'nv3@example.com', HoTen: 'NV 3', VaiTro: 'Nhân viên', TrangThai: 'Hoạt động' }));
});

/* =========================================================================
   3) saveRow / deleteRow (bảng không versioning: DM_CONG, DM_NGUOIDUNG)
   ========================================================================= */
test('saveRow: thêm mới rồi cập nhật đúng theo _id (không tạo dòng trùng)', () => {
  const env = createConfiguredGasEnv();
  const row = { _id: 'id_abc', Email: 'a@x.com', HoTen: 'A', VaiTro: 'Nhân viên', TrangThai: 'Hoạt động' };
  env.context.saveRow('DM_NGUOIDUNG', row);
  env.context.saveRow('DM_NGUOIDUNG', Object.assign({}, row, { HoTen: 'A đã sửa' }));

  const sheet = env.getSpreadsheet(env.congTyId).getSheetByName('DM_NGUOIDUNG');
  const dataRows = sheet.data.slice(1).filter(r => r.some(v => v !== '' && v !== undefined));
  assert.equal(dataRows.length, 1, 'không được tạo thêm dòng mới khi sửa theo đúng _id');
});

/* =========================================================================
   4) commitChange_ — TRỌNG TÂM: cơ chế lịch sử phiên bản + bug đã sửa
   ========================================================================= */
test('commitChange_: "Thêm" tạo đúng dòng lịch sử đầu tiên (TrangThaiBanGhi=Thêm mới, HieuLucDenNgay trống)', () => {
  const env = createConfiguredGasEnv();
  const payload = { _id: 'nv_001', MaNV: 'NV001', TenNhanVien: 'Nguyễn Văn A', SoCCCD: '001', NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc' };
  env.context.commitChange_('DM_NHANVIEN', payload, 'Thêm');

  const row = env.context.getLatestRowById_('DM_NHANVIEN', 'nv_001');
  assert.equal(row.TenNhanVien, 'Nguyễn Văn A');
  assert.equal(row.TrangThaiBanGhi, 'Thêm mới');
  assert.equal(row.HieuLucDenNgay, undefined); // để trống = vô thời hạn
});

test('commitChange_: "Sửa" thêm 1 dòng lịch sử MỚI, giữ nguyên _id, không sửa đè dòng cũ', () => {
  const env = createConfiguredGasEnv();
  env.context.commitChange_('DM_NHANVIEN', {
    _id: 'nv_002', MaNV: 'NV002', TenNhanVien: 'Trần Thị B', SoCCCD: '002',
    NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc', HieuLucTuNgay: '2024-01-01',
  }, 'Thêm');
  env.context.commitChange_('DM_NHANVIEN', {
    _id: 'nv_002', MaNV: 'NV002', TenNhanVien: 'Trần Thị B (đổi tên đệm)', SoCCCD: '002',
    NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc', HieuLucTuNgay: '2024-06-01',
  }, 'Sửa');

  const sheet = env.getSpreadsheet(env.nhanSuId).getSheetByName('DM_NHANVIEN');
  const rows = sheet.data.slice(1).filter(r => r[0] === 'nv_002');
  assert.equal(rows.length, 2, 'phải có đúng 2 dòng lịch sử (không ghi đè dòng cũ)');

  const latest = env.context.getLatestRowById_('DM_NHANVIEN', 'nv_002');
  assert.equal(latest.TenNhanVien, 'Trần Thị B (đổi tên đệm)');
  assert.equal(latest.TrangThaiBanGhi, 'Sửa');
});

test('commitChange_: "Sửa" cho phép XOÁ TRẮNG một trường tuỳ chọn (không bị "vá" ngược lại giá trị cũ)', () => {
  // Đây là hành vi cần giữ đúng sau khi vá bug "Hủy" làm mất dữ liệu — client luôn gửi ĐỦ mọi
  // trường của form khi Sửa (kể cả rỗng), nên payload phải được áp thẳng, không lấy `current` để vá.
  const env = createConfiguredGasEnv();
  env.context.commitChange_('DM_LUONG_BS', {
    _id: 'bs_001', _parentId: 'luong_001', NoiDung: 'Ngưỡng 1', NguongBoSung: '10', DonGiaBoSung: '5000', GhiChu: 'Ghi chú ban đầu',
  }, 'Thêm');
  // Sửa: người dùng xoá trắng GhiChu (gửi '' — client luôn gửi đủ field khi Sửa)
  env.context.commitChange_('DM_LUONG_BS', {
    _id: 'bs_001', _parentId: 'luong_001', NoiDung: 'Ngưỡng 1', NguongBoSung: '10', DonGiaBoSung: '5000', GhiChu: '',
  }, 'Sửa');

  const latest = env.context.getLatestRowById_('DM_LUONG_BS', 'bs_001');
  assert.equal(latest.GhiChu, undefined, 'GhiChu phải được xoá trắng thật sự, không bị phục hồi giá trị cũ');
  assert.equal(latest.NoiDung, 'Ngưỡng 1', 'các trường khác không bị ảnh hưởng');
});

test('commitChange_: "Hủy" với payload TỐI GIẢN {_id} phải GIỮ NGUYÊN toàn bộ dữ liệu cũ (regression test cho bug đã sửa)', () => {
  const env = createConfiguredGasEnv();
  const full = {
    _id: 'nv_003', MaNV: 'NV003', TenNhanVien: 'Lê Văn C', SoCCCD: '003',
    NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc',
  };
  env.context.commitChange_('DM_NHANVIEN', full, 'Thêm');

  // Client thật khi bấm "Hủy" chỉ gửi {_id} (xem JavaScript.html: saveDraftRow(table, {_id:id}, 'Xóa'))
  env.context.commitChange_('DM_NHANVIEN', { _id: 'nv_003' }, 'Hủy');

  const latest = env.context.getLatestRowById_('DM_NHANVIEN', 'nv_003');
  assert.equal(latest.TrangThaiBanGhi, 'Hủy');
  assert.equal(latest.MaNV, 'NV003', 'MaNV không được bị xoá trắng sau khi Hủy');
  assert.equal(latest.TenNhanVien, 'Lê Văn C', 'TenNhanVien không được bị xoá trắng sau khi Hủy');
  assert.equal(latest.SoCCCD, '003', 'SoCCCD không được bị xoá trắng sau khi Hủy');

  const sheet = env.getSpreadsheet(env.nhanSuId).getSheetByName('DM_NHANVIEN');
  const rows = sheet.data.slice(1).filter(r => r[0] === 'nv_003');
  assert.equal(rows.length, 2, 'phải có 2 dòng lịch sử: Thêm mới + Hủy, dòng Thêm mới không bị xoá');
});

test('commitChange_: "Hủy" trên bảng con vẫn giữ nguyên _parentId (không đứt liên kết cha-con)', () => {
  const env = createConfiguredGasEnv();
  env.context.commitChange_('CT_THONGTINCANHAN', {
    _id: 'ca_001', _parentId: 'nv_999', SoCCCD: '009', NgaySinh: '1990-01-01', GioiTinh: 'Nam',
  }, 'Thêm');
  env.context.commitChange_('CT_THONGTINCANHAN', { _id: 'ca_001' }, 'Hủy');

  const latest = env.context.getLatestRowById_('CT_THONGTINCANHAN', 'ca_001');
  assert.equal(latest._parentId, 'nv_999');
  assert.equal(latest.SoCCCD, '009');
  assert.equal(latest.TrangThaiBanGhi, 'Hủy');
});

test('commitChange_: DM_CONG (singleton, không versioning) — Admin sửa ghi đè trực tiếp, không tạo lịch sử', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo(); // bootstrap Admin
  env.context.updateCompanyProfile({ TenCongty: 'Cty A', DiaChi: 'DN', MST: '123', SoDT: '0900000000', DaiDienPhapLuat: 'X' });
  env.context.updateCompanyProfile({ TenCongty: 'Cty A (đổi tên)', DiaChi: 'DN', MST: '123', SoDT: '0900000000', DaiDienPhapLuat: 'X' });

  const sheet = env.getSpreadsheet(env.congTyId).getSheetByName('DM_CONG');
  const rows = sheet.data.slice(1).filter(r => r.some(v => v !== '' && v !== undefined));
  assert.equal(rows.length, 1, 'DM_CONG chỉ có đúng 1 dòng');
  assert.equal(rows[0][sheet.data[0].indexOf('TenCongty')], 'Cty A (đổi tên)');
});

/* =========================================================================
   5) filterLatestVersions_ — chỉ giữ 1 dòng mới nhất mỗi _id
   ========================================================================= */
test('filterLatestVersions_: giữ đúng dòng có HieuLucTuNgay lớn nhất cho mỗi _id, kể cả khi dòng đó là Hủy', () => {
  const env = createGasEnv();
  const rows = [
    { _id: 'a', HieuLucTuNgay: '2024-01-01', TrangThaiBanGhi: 'Thêm mới', Ten: 'v1' },
    { _id: 'a', HieuLucTuNgay: '2024-06-01', TrangThaiBanGhi: 'Sửa', Ten: 'v2' },
    { _id: 'a', HieuLucTuNgay: '2024-03-01', TrangThaiBanGhi: 'Sửa', Ten: 'v-xen-giua' },
    { _id: 'b', HieuLucTuNgay: '2024-02-01', TrangThaiBanGhi: 'Hủy', Ten: 'b đã huỷ' },
  ];
  const out = env.context.filterLatestVersions_('DM_NHANVIEN', rows);
  const byId = Object.fromEntries(out.map(r => [r._id, r]));
  assert.equal(byId.a.Ten, 'v2', 'phải lấy đúng bản mới nhất, không phải bản chèn sau cùng trong mảng');
  assert.equal(byId.b.TrangThaiBanGhi, 'Hủy', 'dòng Hủy vẫn phải hiển thị (không bị lọc biến mất)');
});

test('filterLatestVersions_: bảng không versioning (DM_CONG/DM_NGUOIDUNG) trả nguyên danh sách', () => {
  const env = createGasEnv();
  const rows = [{ _id: 'x', a: 1 }, { _id: 'x', a: 2 }];
  assert.deepEqual(env.context.filterLatestVersions_('DM_CONG', rows), rows);
});

/* =========================================================================
   6) DRAFT WORKFLOW — saveDraftRow / findDraftRow_ / approveDraft / rejectDraft
   ========================================================================= */
test('saveDraftRow: chặn người không có quyền canEdit', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo();
  env.context.saveUserPermission({ Email: 'nv-khongquyen@example.com', HoTen: 'X', VaiTro: 'Nhân viên', TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv-khongquyen@example.com');
  assert.throws(
    () => env.context.saveDraftRow('DM_NHANVIEN', { MaNV: 'X' }, 'Thêm'),
    /không có quyền/
  );
});

test('saveDraftRow -> findDraftRow_: đọc lại đúng payload đã gửi (rỗng thành undefined)', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo();
  env.context.saveUserPermission({ Email: 'nv1@example.com', HoTen: 'NV1', VaiTro: 'Nhân viên', ChoPhepThaoTac: true, TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv1@example.com');

  const { draftRowId, targetId } = env.context.saveDraftRow('DM_NHANVIEN', {
    MaNV: 'NV010', TenNhanVien: 'Phạm D', SoCCCD: '', NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc',
  }, 'Thêm');

  const found = env.context.findDraftRow_('DM_NHANVIEN', draftRowId);
  assert.ok(found);
  assert.equal(found.action, 'Thêm');
  assert.equal(found.payload._id, targetId);
  assert.equal(found.payload.TenNhanVien, 'Phạm D');
  assert.equal(found.payload.SoCCCD, undefined, 'chuỗi rỗng phải đọc lại thành undefined');
});

test('getPendingDrafts: chỉ trả các dòng đang "Chờ duyệt"', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo();
  env.context.saveUserPermission({ Email: 'nv1@example.com', HoTen: 'NV1', VaiTro: 'Nhân viên', ChoPhepThaoTac: true, TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv1@example.com');
  env.context.saveDraftRow('DM_NHANVIEN', { MaNV: 'NV020', TenNhanVien: 'E', SoCCCD: '020', NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc' }, 'Thêm');

  let pending = env.context.getPendingDrafts();
  assert.equal((pending.DM_NHANVIEN || []).length, 1);

  env.setCurrentUser('saoluucvhak@gmail.com');
  const draftId = pending.DM_NHANVIEN[0].DraftRowId;
  env.context.rejectDraft('DM_NHANVIEN', draftId);

  pending = env.context.getPendingDrafts();
  assert.equal((pending.DM_NHANVIEN || []).length, 0, 'sau khi Từ chối không còn hiện trong danh sách chờ duyệt');
});

test('approveDraft: chặn người không có quyền canApprove', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo();
  env.context.saveUserPermission({ Email: 'nv1@example.com', HoTen: 'NV1', VaiTro: 'Nhân viên', ChoPhepThaoTac: true, TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv1@example.com');
  const { draftRowId } = env.context.saveDraftRow('DM_NHANVIEN', { MaNV: 'NV030', TenNhanVien: 'F', SoCCCD: '030', NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc' }, 'Thêm');
  assert.throws(() => env.context.approveDraft('DM_NHANVIEN', draftRowId), /không có quyền duyệt/);
});

test('END-TO-END: Thêm -> Duyệt -> Hủy -> Duyệt qua đúng luồng nháp thật, dữ liệu KHÔNG bị mất', () => {
  const env = createConfiguredGasEnv();
  env.context.getCurrentUserInfo(); // bootstrap Admin (đồng thời canApprove/canEdit=true vì canAdmin)
  const admin = 'saoluucvhak@gmail.com';

  // 1) Nhân viên có quyền thao tác gửi nháp "Thêm"
  env.context.saveUserPermission({ Email: 'nv1@example.com', HoTen: 'NV1', VaiTro: 'Nhân viên', ChoPhepThaoTac: true, TrangThai: 'Hoạt động' });
  env.setCurrentUser('nv1@example.com');
  const { draftRowId: d1, targetId } = env.context.saveDraftRow('DM_NHANVIEN', {
    MaNV: 'NV040', TenNhanVien: 'Hoàng Văn G', SoCCCD: '040', NgayVaoHeThong: '2024-01-01', TrangThai: 'Đang làm việc',
  }, 'Thêm');

  // 2) Admin duyệt -> phải xuất hiện trong bản chính
  env.setCurrentUser(admin);
  env.context.approveDraft('DM_NHANVIEN', d1);
  let latest = env.context.getLatestRowById_('DM_NHANVIEN', targetId);
  assert.equal(latest.TenNhanVien, 'Hoàng Văn G');
  assert.equal(latest.TrangThaiBanGhi, 'Thêm mới');

  // 3) Nhân viên gửi nháp "Hủy" (chỉ {_id}, đúng như UI thật gửi)
  env.setCurrentUser('nv1@example.com');
  const { draftRowId: d2 } = env.context.saveDraftRow('DM_NHANVIEN', { _id: targetId }, 'Xóa');

  // 4) Admin duyệt Hủy -> dữ liệu cũ phải còn nguyên, chỉ đổi trạng thái
  env.setCurrentUser(admin);
  env.context.approveDraft('DM_NHANVIEN', d2);
  latest = env.context.getLatestRowById_('DM_NHANVIEN', targetId);
  assert.equal(latest.TrangThaiBanGhi, 'Hủy');
  assert.equal(latest.TenNhanVien, 'Hoàng Văn G', 'BUG: dữ liệu bị mất sau khi duyệt Hủy qua toàn bộ luồng nháp thật');
  assert.equal(latest.MaNV, 'NV040');
  assert.equal(latest.SoCCCD, '040');
});

/* =========================================================================
   7) bulkImportData — nạp dữ liệu ban đầu
   ========================================================================= */
test('bulkImportData: chỉ Admin được gọi, bỏ qua bảng lạ và DM_NGUOIDUNG', () => {
  const env = createConfiguredGasEnv();
  env.setCurrentUser('nguoi-thuong@example.com');
  assert.throws(() => env.context.bulkImportData({ DM_CHUCVU: [{ MaCV: '1', TenCV: 'GĐ' }] }), /Chỉ Admin/);

  env.setCurrentUser('saoluucvhak@gmail.com');
  const summary = env.context.bulkImportData({
    DM_CHUCVU: [{ MaCV: '1', TenCV: 'Giám đốc' }],
    BANG_KHONG_TON_TAI: [{ x: 1 }],
    DM_NGUOIDUNG: [{ Email: 'hack@example.com', VaiTro: 'Admin' }],
  });
  // summary được tạo BÊN TRONG vm context (realm khác với test file) nên deepStrictEqual với 1 object
  // literal ngoài này sẽ báo "same structure but not reference-equal" (khác Object.prototype giữa 2
  // realm) — dùng {...summary} để có 1 plain object thuộc realm của Node/test trước khi so sánh.
  assert.deepEqual({ ...summary }, { DM_CHUCVU: 1 });
});
