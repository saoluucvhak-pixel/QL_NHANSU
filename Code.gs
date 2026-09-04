/**
 * QUẢN LÝ NHÂN SỰ — Google Apps Script backend
 * Dữ liệu tách làm 3 Google Sheet RIÊNG BIỆT (không phải sheet gắn với script này):
 *   1) DM_CONGCTY_HAK      — hồ sơ công ty (DM_CONG) + toàn bộ danh mục dùng chung (DM_*, CT_BACTHUE_TNCN)
 *   2) THONGTINNHANSU_HAK  — DM_NHANVIEN + toàn bộ hồ sơ nhân sự/hợp đồng (CT_*)
 *   3) Draft_NHANSU_HAK    — nhật ký ghi nhận các lần thêm/sửa Phòng ban (audit log)
 *
 * Link tới 3 sheet này được lưu trong Script Properties (không hardcode trong code khi chạy thật —
 * DEFAULT_CONFIG bên dưới chỉ để tiện điền sẵn form khởi tạo lần đầu, bạn có thể xoá/đổi bất cứ lúc nào
 * qua nút "⚙️ Đổi liên kết dữ liệu" trong app để tái sử dụng cho công ty khác).
 *
 * Cột đầu tiên của mỗi sheet luôn là "_id" (khóa nội bộ, tự sinh — đừng sửa tay).
 * Các bảng con có thêm cột "_parentId" (trỏ đến _id của dòng cha).
 */

// =====================================================================
// 0) CẤU HÌNH LIÊN KẾT (Script Properties) — cho phép tái sử dụng cho công ty khác
// =====================================================================
const CONFIG_KEY = 'HR_CONFIG_V1';

// Email này LUÔN được tự động cấp quyền Admin ngay lần đầu tiên họ mở app (nếu DM_NGUOIDUNG còn trống).
const ADMIN_EMAIL = 'saoluucvhak@gmail.com';

// Chỉ dùng để điền sẵn (placeholder) trong form khởi tạo lần đầu của lần deploy này.
// Khi dùng cho công ty khác: xoá liên kết cũ trong app rồi dán link mới, KHÔNG cần sửa code.
const DEFAULT_CONFIG = {
  congTyUrl:  'https://docs.google.com/spreadsheets/d/1FbSQDTSrFHietczdzFxGs0HUYxE4pT-8ia_EBTVo39E/edit',
  nhanSuUrl:  'https://docs.google.com/spreadsheets/d/13RnobxTcJ8tdXUutNUx_aiZXX8PBASiYt9ONrp7Yp6E/edit',
  draftUrl:   'https://docs.google.com/spreadsheets/d/1SAoXxhTka0VjySJrhjdom5YXTdDpK1J6ubgPvO_WUMk/edit',
};

function extractSheetId_(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('Link Google Sheet không hợp lệ: ' + url);
  return m[1];
}

/** Đọc cấu hình đã lưu. Trả về null nếu chưa từng thiết lập. */
function getConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** Gọi từ client lúc mở app: cho biết đã cấu hình liên kết chưa, kèm link mặc định để điền sẵn form. */
function getConfigStatus() {
  const cfg = getConfig_();
  return {
    configured: !!cfg,
    initialized: cfg ? !!cfg.initialized : false,
    congTyUrl: cfg ? cfg.congTyUrl : DEFAULT_CONFIG.congTyUrl,
    nhanSuUrl: cfg ? cfg.nhanSuUrl : DEFAULT_CONFIG.nhanSuUrl,
    draftUrl: cfg ? cfg.draftUrl : DEFAULT_CONFIG.draftUrl,
  };
}

/** Lưu cấu hình liên kết mới — gọi khi người dùng bấm "Lưu & Bắt đầu" ở màn hình khởi tạo.
 *  KHÔNG tự tạo sheet / seed dữ liệu — việc đó chỉ chạy khi người dùng bấm nút "Khởi tạo cấu trúc dữ liệu". */
function saveConfig(congTyUrl, nhanSuUrl, draftUrl) {
  const cfg = {
    congTyId: extractSheetId_(congTyUrl),
    nhanSuId: extractSheetId_(nhanSuUrl),
    draftId: extractSheetId_(draftUrl),
    congTyUrl: congTyUrl,
    nhanSuUrl: nhanSuUrl,
    draftUrl: draftUrl,
    initialized: false,
  };
  // Thử mở cả 3 để chắc chắn có quyền truy cập trước khi lưu.
  SpreadsheetApp.openById(cfg.congTyId);
  SpreadsheetApp.openById(cfg.nhanSuId);
  SpreadsheetApp.openById(cfg.draftId);

  PropertiesService.getScriptProperties().setProperty(CONFIG_KEY, JSON.stringify(cfg));
  return true;
}

/** Tạo đủ mọi sheet còn thiếu + nạp danh mục thật (nếu còn trống) — chỉ chạy khi người dùng
 *  chủ động bấm nút "Khởi tạo cấu trúc dữ liệu" (lần đầu) hoặc "Khởi tạo lại" trong Menu hệ thống. */
function initializeDataStructure() {
  const cfg = getConfig_();
  if (!cfg) throw new Error('Chưa cấu hình liên kết Google Sheet. Hãy thiết lập trước.');
  ensureAllSheets_();
  seedRealDanhMucIfEmpty_();
  cfg.initialized = true;
  PropertiesService.getScriptProperties().setProperty(CONFIG_KEY, JSON.stringify(cfg));
  return true;
}

/** Xoá cấu hình đã lưu — dùng khi muốn đổi sang bộ dữ liệu của công ty khác. Chỉ Admin. */
function resetConfig() {
  const me = getCurrentUserInfo();
  if (!me.canAdmin) throw new Error('Chỉ Admin được đổi liên kết dữ liệu.');
  PropertiesService.getScriptProperties().deleteProperty(CONFIG_KEY);
  return true;
}

/** XOÁ TOÀN BỘ DỮ LIỆU (giữ nguyên cấu trúc cột/tiêu đề) ở CẢ 2 spreadsheet chính
 *  (DM_CONGTY_HAK và THONGTINNHANSU_HAK) — dùng khi cần làm lại từ đầu theo cấu trúc mới.
 *  KHÔNG đụng tới Draft_NHANSU_HAK. CHỈ ADMIN được gọi. KHÔNG THỂ HOÀN TÁC —
 *  hãy chắc chắn đã xuất/sao lưu dữ liệu (nếu cần) trước khi gọi hàm này. */
function wipeAllMainData() {
  const me = getCurrentUserInfo();
  if (!me.canAdmin) throw new Error('Chỉ Admin được xoá dữ liệu.');
  ensureAllSheets_();
  [].concat(COMPANY_TABLES, NHANSU_TABLES).forEach(function (table) {
    const sheet = getOrCreateSheet_(table);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  });
  return true;
}

/** Điền TrangThaiBanGhi = "Thêm mới" cho các dòng hiện đang trống cột này (VD: dữ liệu seed/import
 *  hàng loạt ghi thẳng bằng appendRows_, không đi qua commitChange_). An toàn khi gọi lại nhiều lần. */
function fillMissingTrangThaiBanGhi_() {
  Object.keys(TABLES_SCHEMA).forEach(function (table) {
    if (table === 'DM_CONG' || table === 'DM_NGUOIDUNG') return;
    const sheet = getOrCreateSheet_(table);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const col = TABLES_SCHEMA[table].indexOf('TrangThaiBanGhi') + 1;
    if (col < 1) return;
    const range = sheet.getRange(2, col, lastRow - 1, 1);
    const values = range.getValues();
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      if (!values[i][0]) { values[i][0] = 'Thêm mới'; changed = true; }
    }
    if (changed) range.setValues(values);
  });
}

// =====================================================================
// 1) SCHEMA — tên bảng -> danh sách cột
// =====================================================================
const TABLES_SCHEMA = {
  DM_CONG:            ['_id','TenCongty','DiaChi','MST','SoDT','DaiDienPhapLuat'],
  DM_NGUOIDUNG:       ['_id','Email','HoTen','VaiTro','ChoPhepDuyet','ChoPhepThaoTac','TrangThai','NgayCap'],

  DM_NHANVIEN:        ['_id','MaNV','TenNhanVien','SoCCCD','NgayVaoHeThong','TrangThai'],

  DM_CHUCVU:          ['_id','NgayCapNhat','MaCV','TenCV','HieuLucTuNgay','HieuLucDenNgay'],
  DM_PHONGBAN:        ['_id','NgayCapNhat','MaKhoi','TenKhoi','MaPB','TenPB','HieuLucTuNgay','HieuLucDenNgay'],
  DM_LUONG:           ['_id','NgayCapNhat','MaLuong','MaHinhThucLuong','HinhThucLuong','SoTienKhoan',
                        'CachTinh','NgayGiamTru','HieuLucTuNgay','HieuLucDenNgay'],
  DM_LUONG_BS:        ['_id','_parentId','NoiDung','NguongBoSung','DonGiaBoSung','GhiChu'],
  DM_PHUCAP:          ['_id','NgayCapNhat','MaPhuCap','TenPhuCap','SoTien','TyLe','ThamChieu','CachTinh','HieuLucTuNgay','HieuLucDenNgay'],
  DM_TANGCA:          ['_id','NgayCapNhat','MaTangCa','NoiDungTangCa','HeSoTangCa','TienTangCaCoDinh','CachTinh','HieuLucTuNgay','HieuLucDenNgay'],
  DM_HOTRO:           ['_id','NgayCapNhat','MaHoTro','TenHoTro','SoTien','CachTinh','HieuLucTuNgay','HieuLucDenNgay'],
  DM_BAOHIEM:         ['_id','MaBaoHiem','NoiDung','DN_BHXH','DN_BHYT','DN_BHTN','DN_KPCD',
                        'NLD_BHXH','NLD_BHYT','NLD_BHTN','NLD_KPCD','HieuLucTuNgay','HieuLucDenNgay'],
  DM_TNCN:            ['_id','MaThueTNCN','NoiDung','MucThue','GhiChu','HieuLucTuNgay','HieuLucDenNgay'],
  CT_BACTHUE_TNCN:    ['_id','_parentId','Bac','ThuNhapTu','ThuNhapDen','TyLeDong','MucDongToiDaBac'],
  DM_CC:              ['_id','NgayCapNhat','MaCC','NoiDung','HinhThucCong','DienGiai','HieuLucTuNgay','HieuLucDenNgay'],
  DM_GT_TNCN:         ['_id','MaGiamTru','SoNguoi','SoTien','HieuLucTuNgay','HieuLucDenNgay'],

  CT_THONGTINCANHAN:      ['_id','_parentId','SoCCCD','NgayCap','NoiCap','NgaySinh','GioiTinh','QuocTich',
                            'DanToc','TinhTrangHonNhan','ThuongTru','DiaChiHienTai','SoDienThoai','HieuLucTuNgay'],
  CT_TRINHDOHOCVAN:       ['_id','_parentId','TrinhDoHocVan','ChuyenMon','BangCap','FileHoSo','NgayCapBang','SoHoSo'],
  CT_NHANTHAN:            ['_id','_parentId','HoTenNhanThan','QuanHeNhanThan','SoCCCDNhanThan','NgayCap',
                            'NoiCap','MaSoThue','DangKyPhuThuoc','HieuLucTuNgay'],
  CT_THONGTINTHANHTOAN:   ['_id','_parentId','SoTaiKhoan','TenNganHang','ChiNhanh','HieuLucTuNgay'],
  CT_SUCKHOE:             ['_id','_parentId','TienSuBenh','TinhTrang','HieuLucTuNgay'],
  CT_THONGTINLIENHE:      ['_id','_parentId','DiaChiLienHe','NguoiLienHe','QuanHe','SoDienThoai','Email','GhiChu'],
  CT_THONGTINNGHENGHIEP:  ['_id','_parentId','TuNgay','DenNgay','TenCongTy','ViTriDamNhiem','ChuyenMon','LyDoNghi'],
  CT_QUATRINHCONGTAC:     ['_id','_parentId','TuNgay','DenNgay','MaPB','MaCV','LoaiBienDong','GhiChu'],
  CT_QUATRINHLAMVIEC:     ['_id','_parentId','SoHDLD','NgayVaoLam','NgayChamDutHDLD','HinhThucHDLD','HieuLucTuNgay','GhiChu'],
  CT_KHAMSUCKHOE:         ['_id','_parentId','SoGiayKham','HinhThucKham','NgayKham','TinhTrang','HieuLucTuNgay'],
  CT_QUYENLOIPHEP:        ['_id','_parentId','NamApDung','SoNgayDuocCap','SoNgayCongDon','HieuLucTuNgay','GhiChu'],
  CT_NGHIPHEP:            ['_id','_parentId','TuNgay','DenNgay','SoNgayNghi','TrangThaiDuyet','NguoiDuyet','GhiChu'],
  CT_NGHIOM:              ['_id','_parentId','TuNgay','DenNgay','SoNgayNghi','CoGiayChungNhanBHXH',
                            'SoGiayChungNhan','TrangThaiDuyet','GhiChu'],
  // MaHinhThucLuong = nhóm lương (LTG/LSP, giống lựa chọn trong DM_LUONG.MaHinhThucLuong).
  // MaLuong = 1 hoặc nhiều mã lương cụ thể thuộc nhóm đó (DM_LUONG._id), cách nhau dấu phẩy — khi tính lương sẽ tách và tham chiếu từng mã.
  // MaHoTro = 1 hoặc nhiều mã hỗ trợ (DM_HOTRO._id), cách nhau dấu phẩy (thay cho MaHoTro/MaHoTro2 trước đây).
  // MaTangCa = 1 hoặc nhiều mã tăng ca (DM_TANGCA._id), cách nhau dấu phẩy.
  // MaBHXH = mã HÌNH THỨC đóng BHXH (tham chiếu DM_BAOHIEM, VD "Đóng đầy đủ"/"Không tham gia").
  CT_CHITIETHOPDONG:      ['_id','_parentId','MaCongTac','TuNgay','DenNgay','MaPhongBan','MaCV',
                            'MaHinhThucLuong','MaLuong','LuongCoBan','LuongThoaThuan','HTTT',
                            'MaBHXH','MaTNCN','MaPhuCap','MaHoTro','MaTangCa',
                            'LoaiPhuLuc','HieuLucTuNgay','GhiChu'],
  CT_NOIQUY:              ['_id','_parentId','Ngay','NoiDungViPham','TinhTrangXuLy','NoiDungXuLy'],
  CT_KHENTHUONG:          ['_id','_parentId','Ngay','HinhThucKhenThuong','LyDo','GiaTri','GhiChu'],
  CT_TAILIEU:             ['_id','_parentId','LoaiTaiLieu','TenTaiLieu','File','NgayTaiLieu','GhiChu'],
};

// =====================================================================
// 1.1) CỘT HỆ THỐNG CHO CƠ CHẾ "LỊCH SỬ PHIÊN BẢN" — tự động bổ sung vào CUỐI schema của
// MỌI bảng, TRỪ DM_CONG (hồ sơ công ty, chỉ 1 dòng) và DM_NGUOIDUNG (phân quyền đăng nhập,
// ghi/sửa/xoá trực tiếp, không cần lưu lịch sử phiên bản):
//   - HieuLucTuNgay / HieuLucDenNgay: cửa sổ hiệu lực của dòng (nếu bảng đã có sẵn HieuLucTuNgay
//     thì giữ nguyên, chỉ bổ sung HieuLucDenNgay nếu còn thiếu).
//   - TrangThaiBanGhi: "Thêm mới" | "Sửa" | "Hủy" — hành động đã tạo ra dòng này.
// Việc chèn ở CUỐI (không chèn giữa) để không phá vỡ các đoạn code đọc theo tên cột hiện có.
(function augmentSchemasForVersioning_() {
  Object.keys(TABLES_SCHEMA).forEach(function (table) {
    if (table === 'DM_CONG' || table === 'DM_NGUOIDUNG') return;
    const cols = TABLES_SCHEMA[table];
    if (cols.indexOf('HieuLucTuNgay') === -1) cols.push('HieuLucTuNgay');
    if (cols.indexOf('HieuLucDenNgay') === -1) cols.push('HieuLucDenNgay');
    if (cols.indexOf('TrangThaiBanGhi') === -1) cols.push('TrangThaiBanGhi');
  });
})();

// Bảng nào thuộc sheet DM_CONGCTY_HAK, bảng nào thuộc THONGTINNHANSU_HAK
const COMPANY_TABLES = ['DM_CONG','DM_NGUOIDUNG','DM_CHUCVU','DM_PHONGBAN','DM_LUONG','DM_PHUCAP','DM_TANGCA',
  'DM_HOTRO','DM_BAOHIEM','DM_TNCN','CT_BACTHUE_TNCN','DM_CC','DM_GT_TNCN','DM_LUONG_BS'];
const NHANSU_TABLES = ['DM_NHANVIEN','CT_THONGTINCANHAN','CT_TRINHDOHOCVAN','CT_NHANTHAN','CT_THONGTINTHANHTOAN',
  'CT_SUCKHOE','CT_THONGTINLIENHE','CT_THONGTINNGHENGHIEP','CT_QUATRINHCONGTAC','CT_QUATRINHLAMVIEC',
  'CT_KHAMSUCKHOE','CT_QUYENLOIPHEP','CT_NGHIPHEP','CT_NGHIOM','CT_CHITIETHOPDONG','CT_NOIQUY',
  'CT_KHENTHUONG','CT_TAILIEU'];

// Bảng nào áp dụng cơ chế "lịch sử phiên bản": mỗi lần Thêm/Sửa/Hủy KHÔNG ghi đè / không xoá vật lý —
// luôn thêm 1 dòng mới GIỮ NGUYÊN _id cũ (để _parentId của các bảng con vẫn trỏ đúng), gắn
// TrangThaiBanGhi + Hiệu lực từ ngày; dòng cũ (cùng _id) sẽ tự động có Hiệu lực đến ngày = đúng
// Hiệu lực từ ngày của dòng mới (công thức MINIFS, xem hieuLucDenFormula_). Áp dụng cho TẤT CẢ các
// bảng, trừ DM_CONG (hồ sơ công ty, chỉ 1 dòng) và DM_NGUOIDUNG (phân quyền đăng nhập — ghi/sửa/xoá
// trực tiếp, không cần lịch sử).
const VERSIONED_TABLES = {};
Object.keys(TABLES_SCHEMA).forEach(function (t) {
  if (t !== 'DM_CONG' && t !== 'DM_NGUOIDUNG') VERSIONED_TABLES[t] = '_id';
});

// Bảng nào chỉ được đúng 1 dòng dữ liệu (hồ sơ công ty)
const SINGLETON_TABLES = ['DM_CONG'];

// TOÀN BỘ các bảng đi qua cơ chế "Nháp -> Duyệt": Thêm/Sửa/Xóa đều lưu vào Draft_NHANSU_HAK trước,
// phải có người bấm "Duyệt" mới thật sự ghi vào bản chính (DM_CONGCTY_HAK / THONGTINNHANSU_HAK).
const DRAFT_TABLES = Object.keys(TABLES_SCHEMA).filter(t => t !== 'DM_CONG' && t !== 'DM_NGUOIDUNG');
const DRAFT_META_HEADERS = ['DraftRowId','TrangThaiDuyet','HanhDong','NguoiTao','ThoiGianTao','NguoiDuyet','ThoiGianDuyet'];

// =====================================================================
// 1.5) PHÂN QUYỀN NGƯỜI DÙNG — Admin -> Quản lý -> Nhân viên
// =====================================================================
/** Xác định người đang mở app là ai và có quyền gì. Tự động cấp quyền Admin cho ADMIN_EMAIL
 *  nếu bảng người dùng còn trống (lần chạy đầu tiên). */
function getCurrentUserInfo() {
  let email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = ''; }
  const webAppUrl = getWebAppUrl_();
  const switchAccountUrl = buildAccountChooserUrl_(webAppUrl);
  const base = { email, role: null, hoTen: '', canAdmin: false, canApprove: false, canEdit: false,
    canManageUsers: false, webAppUrl, switchAccountUrl };
  if (!email) return Object.assign(base, { error: 'Không xác định được tài khoản Google đang đăng nhập. Vui lòng đăng nhập tài khoản Google của bạn rồi thử lại.' });

  const cfg = getConfig_();
  if (!cfg) return Object.assign(base, { bootstrapPending: true }); // chưa cấu hình liên kết -> chưa có chỗ lưu người dùng

  const sheet = getOrCreateSheet_('DM_NGUOIDUNG');
  let users = sheetToObjects_(sheet);

  if (users.length === 0 && email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
    const row = { _id: uid_(), Email: email, HoTen: 'Quản trị viên', VaiTro: 'Admin',
      ChoPhepDuyet: '', ChoPhepThaoTac: '', TrangThai: 'Hoạt động',
      NgayCap: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') };
    saveRow('DM_NGUOIDUNG', row);
    users = [row];
  }

  const me = users.find(u => String(u.Email || '').toLowerCase() === email.toLowerCase());
  // Email đang đăng nhập không khớp bất kỳ tài khoản nào đã đăng ký (hoặc đã bị khoá)
  // -> báo "denied" kèm link chuyển tài khoản Google để người dùng tự đăng nhập đúng tài khoản.
  if (!me || me.TrangThai === 'Khóa') return Object.assign(base, { denied: true, locked: !!me });

  const truthy = v => v === true || v === 'true' || v === 'TRUE';
  const role = me.VaiTro;
  const canAdmin = role === 'Admin';
  const canApprove = canAdmin || (role === 'Quản lý' && truthy(me.ChoPhepDuyet));
  const canEdit = role === 'Nhân viên' && truthy(me.ChoPhepThaoTac);
  const canManageUsers = canAdmin || role === 'Quản lý';
  return { email, role, hoTen: me.HoTen || '', canAdmin, canApprove, canEdit, canManageUsers,
    webAppUrl, switchAccountUrl };
}

/** URL công khai của web app hiện tại (dùng để quay lại sau khi người dùng chọn tài khoản Google khác). */
function getWebAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/** Link mở màn hình "Chọn tài khoản" của Google — cho phép người dùng chuyển sang đúng tài khoản
 *  Google đã được đăng ký/cấp quyền, hoặc đăng nhập nếu chưa đăng nhập tài khoản nào.
 *  Sau khi chọn xong, Google sẽ tự quay lại đúng địa chỉ web app (continue). */
function buildAccountChooserUrl_(webAppUrl) {
  if (!webAppUrl) return '';
  return 'https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent(webAppUrl);
}

/** Danh sách người dùng — Admin thấy tất cả, Quản lý chỉ thấy Nhân viên. */
function listUsers() {
  const me = getCurrentUserInfo();
  if (!me.canManageUsers) throw new Error('Bạn không có quyền xem danh sách người dùng.');
  const sheet = getOrCreateSheet_('DM_NGUOIDUNG');
  let users = sheetToObjects_(sheet);
  if (me.role === 'Quản lý') users = users.filter(u => u.VaiTro === 'Nhân viên');
  return users;
}

/** Thêm/sửa quyền 1 người dùng. Quản lý chỉ được thao tác với vai trò Nhân viên. */
function saveUserPermission(row) {
  const me = getCurrentUserInfo();
  if (!me.canManageUsers) throw new Error('Bạn không có quyền phân quyền người dùng.');
  if (me.role === 'Quản lý' && row.VaiTro !== 'Nhân viên') {
    throw new Error('Quản lý chỉ được phân quyền cho Nhân viên.');
  }
  if (!row._id) row._id = uid_();
  if (!row.NgayCap) row.NgayCap = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  saveRow('DM_NGUOIDUNG', row);
  return true;
}

function deleteUserPermission(id) {
  const me = getCurrentUserInfo();
  if (!me.canManageUsers) throw new Error('Bạn không có quyền phân quyền người dùng.');
  deleteRow('DM_NGUOIDUNG', id);
  return true;
}

/** Đổi thông tin hồ sơ công ty — chỉ Admin. Ghi thẳng vào bản chính (Admin là cấp cao nhất, không cần duyệt). */
function updateCompanyProfile(row) {
  const me = getCurrentUserInfo();
  if (!me.canAdmin) throw new Error('Chỉ Admin được đổi thông tin công ty.');
  saveRow('DM_CONG', row);
  return true;
}

// =====================================================================
// 1.6) TÀI LIỆU ĐÍNH KÈM — tải lên Google Drive (dùng DriveApp, có sẵn, không cần bật thêm dịch vụ)
// =====================================================================
const ATTACHMENT_FOLDER_PROP = 'ATTACHMENT_FOLDER_ID';

function getAttachmentFolder_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty(ATTACHMENT_FOLDER_PROP);
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (e) { /* thư mục cũ bị xoá -> tạo lại bên dưới */ }
  }
  const folder = DriveApp.createFolder('HAK_NhanSu_TaiLieuDinhKem');
  props.setProperty(ATTACHMENT_FOLDER_PROP, folder.getId());
  return folder;
}

/** Tải 1 file (đã mã hoá base64 từ trình duyệt) lên Google Drive, trả về link xem file.
 *  Chỉ người có quyền thao tác (canEdit) mới được gọi — cùng quyền với việc thêm/sửa dữ liệu. */
function uploadAttachment(base64Data, filename, mimeType) {
  const me = getCurrentUserInfo();
  if (!me.canEdit) throw new Error('Bạn không có quyền tải tài liệu lên.');
  if (!base64Data) throw new Error('Không có dữ liệu file.');
  const folder = getAttachmentFolder_();
  const bytes = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', filename || 'tai-lieu');
  const file = folder.createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* bỏ qua nếu domain hạn chế chia sẻ ra ngoài */ }
  return { url: file.getUrl(), name: file.getName(), id: file.getId() };
}

// =====================================================================
// 2) WEB APP ENTRY POINT
// =====================================================================
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Quản lý Nhân sự')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// =====================================================================
// 3) SHEET ROUTING — mỗi bảng thuộc 1 trong 3 Spreadsheet ngoài
// =====================================================================
let _ssCache = {}; // cache trong 1 lần thực thi — tránh mở lại cùng 1 Spreadsheet nhiều lần (rất chậm)
function getSpreadsheetById_(id) {
  if (!_ssCache[id]) {
    _ssCache[id] = SpreadsheetApp.openById(id);
  }
  return _ssCache[id];
}
function getSpreadsheetForTable_(table) {
  const cfg = getConfig_();
  if (!cfg) throw new Error('Chưa cấu hình liên kết Google Sheet. Hãy thiết lập trước.');
  if (COMPANY_TABLES.indexOf(table) > -1) return getSpreadsheetById_(cfg.congTyId);
  if (NHANSU_TABLES.indexOf(table) > -1) return getSpreadsheetById_(cfg.nhanSuId);
  throw new Error('Không xác định được Sheet cho bảng: ' + table);
}
function getDraftSpreadsheet_() {
  const cfg = getConfig_();
  if (!cfg) throw new Error('Chưa cấu hình liên kết Google Sheet. Hãy thiết lập trước.');
  return getSpreadsheetById_(cfg.draftId);
}

// Các cột chứa số nhưng PHẢI giữ nguyên dạng chữ (số 0 đầu, số quá dài...) — luôn ép định dạng
// Văn bản ('@') để Google Sheets không tự động chuyển thành số và làm rụng số 0 đầu.
const TEXT_FORMAT_FIELDS = {
  DM_NHANVIEN: ['SoCCCD'],
  DM_CONG: ['SoDT'],
  CT_THONGTINCANHAN: ['SoCCCD', 'SoDienThoai'],
  CT_TRINHDOHOCVAN: ['SoHoSo'],
  CT_NHANTHAN: ['SoCCCDNhanThan', 'MaSoThue'],
  CT_THONGTINTHANHTOAN: ['SoTaiKhoan'],
  CT_THONGTINLIENHE: ['SoDienThoai'],
  CT_QUATRINHLAMVIEC: ['SoHDLD'],
  CT_KHAMSUCKHOE: ['SoGiayKham'],
  CT_NGHIOM: ['SoGiayChungNhan'],
};

/** Ép định dạng Văn bản cho các cột nhạy cảm (xem TEXT_FORMAT_FIELDS) của 1 sheet, áp dụng cho
 *  toàn bộ chiều cao sheet hiện có + một khoảng dư phía dưới để các dòng thêm sau này cũng giữ
 *  đúng định dạng. CHỈ đổi định dạng hiển thị — không đụng tới dữ liệu đã có. */
function applyTextFormats_(sheet, tableName, headers) {
  const fields = TEXT_FORMAT_FIELDS[tableName];
  if (!fields || fields.length === 0) return;
  const totalRows = Math.max(sheet.getMaxRows(), 2000);
  fields.forEach(function (key) {
    const col = headers.indexOf(key) + 1;
    if (col < 1) return;
    sheet.getRange(2, col, totalRows - 1, 1).setNumberFormat('@');
  });
}

/** Sửa lại định dạng cột (Text) cho TẤT CẢ sheet hiện có — dùng khi dữ liệu cũ đã bị Sheets tự
 *  chuyển "0912..." thành số. CHỈ sửa định dạng hiển thị của các dòng TỪ NAY VỀ SAU; những ô đã bị
 *  mất số 0 từ trước KHÔNG tự khôi phục lại được — cần nhập lại tay các ô đó sau khi chạy hàm này.
 *  Chỉ Admin được gọi. */
function fixLeadingZeroFormats() {
  const me = getCurrentUserInfo();
  if (!me.canAdmin) throw new Error('Chỉ Admin được chạy chức năng này.');
  Object.keys(TEXT_FORMAT_FIELDS).forEach(function (table) {
    const sheet = getOrCreateSheet_(table);
    applyTextFormats_(sheet, table, TABLES_SCHEMA[table]);
  });
  return true;
}

function getOrCreateSheet_(table) {
  const ss = getSpreadsheetForTable_(table);
  return getOrCreateSheetIn_(ss, table, TABLES_SCHEMA[table]);
}
function getOrCreateSheetIn_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  // Tự sửa lại dòng tiêu đề nếu chưa khớp schema (sheet mới tạo, hoặc header bị lệch/thiếu cột) —
  // KHÔNG đụng tới dữ liệu từ dòng 2 trở đi.
  const lastCol = sheet.getLastColumn();
  const existingHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const isSame = existingHeaders.length === headers.length && headers.every((h, i) => existingHeaders[i] === h);
  if (!isSame) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#141F19').setFontColor('#FFFFFF');
    sheet.autoResizeColumns(1, headers.length);
    applyTextFormats_(sheet, name, headers);
  }
  return sheet;
}

/** Tạo đủ mọi sheet còn thiếu ở CẢ 2 spreadsheet chính (không đụng tới Draft, xem ensureDraftSheets_). */
function ensureAllSheets_() {
  Object.keys(TABLES_SCHEMA).forEach(name => getOrCreateSheet_(name));
  [COMPANY_TABLES, NHANSU_TABLES].forEach((list) => {
    if (list.length === 0) return;
    const ss = getSpreadsheetForTable_(list[0]);
    const s1 = ss.getSheetByName('Sheet1');
    if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0 && s1.getLastColumn() === 0) {
      ss.deleteSheet(s1);
    }
  });
  ensureDraftSheets_();
}

function ensureDraftSheets_() {
  const ss = getDraftSpreadsheet_();
  DRAFT_TABLES.forEach(table => {
    const headers = TABLES_SCHEMA[table].concat(DRAFT_META_HEADERS);
    getOrCreateSheetIn_(ss, table, headers);
  });
}

/** Mọi cột ngày tháng trong toàn hệ thống đều có chữ "Ngay" trong tên (HieuLucTuNgay, NgaySinh,
 *  TuNgay, Ngay...) — dùng làm quy ước để tự nhận diện cột nào cần chuyển từ serial number
 *  (Sheets API trả về số ngày kể từ 1899-12-30) sang chuỗi ISO yyyy-MM-dd. */
function isDateField_(fieldName) {
  return fieldName.indexOf('Ngay') > -1 || fieldName.indexOf('ThoiGian') > -1;
}
function serialToIsoDate_(serial) {
  const utcMs = Math.round((serial - 25569) * 86400000);
  return Utilities.formatDate(new Date(utcMs), 'UTC', 'yyyy-MM-dd');
}
/** Với các cột "Thời gian..." (ThoiGianTao/ThoiGianDuyet) — có cả giờ:phút:giây, không chỉ ngày —
 *  cần định dạng đầy đủ, không dùng serialToIsoDate_ (chỉ ra ngày, làm mất giờ). */
function serialToIsoDateTime_(serial) {
  const utcMs = Math.round((serial - 25569) * 86400000);
  return Utilities.formatDate(new Date(utcMs), 'UTC', 'yyyy-MM-dd HH:mm:ss');
}
function rowsToObjectsFromApi_(values, headers) {
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    if (row.length === 0 || row.every(v => v === '' || v === null || v === undefined)) continue;
    const obj = {};
    headers.forEach((h, i) => {
      let v = row[i];
      if (v === undefined || v === null) v = '';
      if (isDateField_(h) && typeof v === 'number') {
        v = (h.indexOf('ThoiGian') > -1) ? serialToIsoDateTime_(v) : serialToIsoDate_(v);
      }
      obj[h] = (v === '') ? undefined : v;
    });
    out.push(obj);
  }
  return out;
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  return rowsToObjects_(values, values.length ? values[0] : []);
}

function rowsToObjects_(values, headers) {
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(v => v === '' || v === null)) continue;
    const obj = {};
    headers.forEach((h, i) => {
      let v = row[i];
      if (v instanceof Date) {
        v = Utilities.formatDate(v, Session.getScriptTimeZone(), h.indexOf('ThoiGian') > -1 ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
      }
      obj[h] = (v === '') ? undefined : v;
    });
    out.push(obj);
  }
  return out;
}

function styleHeaderRow_(sheet, len) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, len).setFontWeight('bold').setBackground('#141F19').setFontColor('#FFFFFF');
  sheet.autoResizeColumns(1, len);
}

/** Đọc dữ liệu 1 bảng trong ĐÚNG 1 lượt gọi API (gộp cả việc kiểm tra/tự sửa header vào chung
 *  lượt đọc dữ liệu) — dùng cho getAllData() vì đây là đường "nóng", gọi mỗi lần mở app. */
function readTableData_(table) {
  const ss = getSpreadsheetForTable_(table);
  const headers = TABLES_SCHEMA[table];
  let sheet = ss.getSheetByName(table);
  if (!sheet) {
    sheet = ss.insertSheet(table);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeaderRow_(sheet, headers.length);
    return [];
  }
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeaderRow_(sheet, headers.length);
    return [];
  }
  const existingHeaders = values[0];
  const same = existingHeaders.length === headers.length && headers.every((h, i) => existingHeaders[i] === h);
  if (!same) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeaderRow_(sheet, headers.length);
  }
  return rowsToObjects_(values, headers);
}

// =====================================================================
// 4) CÔNG THỨC TỰ ĐỘNG (Hiệu lực đến / Mức đóng tối đa của bậc)
// =====================================================================
function columnToLetter_(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}
function colLetter_(table, fieldName) {
  const idx = TABLES_SCHEMA[table].indexOf(fieldName);
  if (idx < 0) throw new Error('Không tìm thấy cột ' + fieldName + ' trong ' + table);
  return columnToLetter_(idx + 1);
}
function hieuLucDenFormula_(table, rowNum) {
  const codeCol = colLetter_(table, VERSIONED_TABLES[table]);
  const tuCol = colLetter_(table, 'HieuLucTuNgay');
  return '=IFERROR(MINIFS(' + tuCol + '2:' + tuCol + '2000,' +
    codeCol + '2:' + codeCol + '2000,' + codeCol + rowNum + ',' +
    tuCol + '2:' + tuCol + '2000,">"&' + tuCol + rowNum + '),"")';
}
function mucDongToiDaFormula_(rowNum) {
  const denCol = colLetter_('CT_BACTHUE_TNCN', 'ThuNhapDen');
  const tuCol = colLetter_('CT_BACTHUE_TNCN', 'ThuNhapTu');
  const tyCol = colLetter_('CT_BACTHUE_TNCN', 'TyLeDong');
  return '=IF(' + denCol + rowNum + '=0,0,(' + denCol + rowNum + '-' + tuCol + rowNum + ')*' + tyCol + rowNum + ')';
}
function applyComputedFormula_(table, rowNum) {
  const sheet = getOrCreateSheet_(table);
  if (VERSIONED_TABLES[table]) {
    const col = TABLES_SCHEMA[table].indexOf('HieuLucDenNgay') + 1;
    sheet.getRange(rowNum, col).setFormula(hieuLucDenFormula_(table, rowNum));
  }
  if (table === 'CT_BACTHUE_TNCN') {
    const col = TABLES_SCHEMA[table].indexOf('MucDongToiDaBac') + 1;
    sheet.getRange(rowNum, col).setFormula(mucDongToiDaFormula_(rowNum));
  }
}
function applyFormulasToAllRows_(table) {
  if (!VERSIONED_TABLES[table] && table !== 'CT_BACTHUE_TNCN') return;
  const sheet = getOrCreateSheet_(table);
  const lastRow = sheet.getLastRow();
  for (let r = 2; r <= lastRow; r++) applyComputedFormula_(table, r);
}

// =====================================================================
// 5) PUBLIC API — gọi từ client qua google.script.run
// =====================================================================
function getAllData() {
  const cfg = getConfig_();
  if (!cfg) throw new Error('Chưa cấu hình liên kết Google Sheet. Hãy thiết lập trước.');
  const congTyData = batchReadSpreadsheet_(cfg.congTyId, COMPANY_TABLES);
  const nhanSuData = batchReadSpreadsheet_(cfg.nhanSuId, NHANSU_TABLES);
  const merged = Object.assign({}, congTyData, nhanSuData);
  Object.keys(merged).forEach(function (t) { merged[t] = filterLatestVersions_(t, merged[t]); });
  return merged;
}

/** Với các bảng có "lịch sử phiên bản" (mọi bảng trừ DM_CONG/DM_NGUOIDUNG): 1 _id có thể ứng với
 *  NHIỀU dòng trong Sheet (mỗi lần Thêm/Sửa/Hủy tạo 1 dòng lịch sử). Hàm này chỉ giữ lại — cho mỗi
 *  _id — đúng 1 dòng có "Hiệu lực từ ngày" MỚI NHẤT để hiển thị lên app (kể cả khi dòng mới nhất đó
 *  có TrangThaiBanGhi = "Hủy", để người dùng vẫn thấy đúng trạng thái hiện tại). */
function filterLatestVersions_(table, rows) {
  if (!VERSIONED_TABLES[table]) return rows;
  const groups = {};
  (rows || []).forEach(function (r) {
    const key = r._id;
    const existing = groups[key];
    if (!existing || String(r.HieuLucTuNgay || '') >= String(existing.HieuLucTuNgay || '')) groups[key] = r;
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}

/** Đọc TOÀN BỘ các bảng thuộc 1 Spreadsheet trong ĐÚNG 1 lượt gọi API (Sheets Advanced Service
 *  batchGet), thay vì 1 lượt gọi riêng cho mỗi bảng — nhanh hơn nhiều lần so với SpreadsheetApp
 *  gọi tuần tự. Yêu cầu bật "Google Sheets API" trong mục Services của Apps Script (xem hướng dẫn). */
function batchReadSpreadsheet_(spreadsheetId, tableNames) {
  const ss = getSpreadsheetById_(spreadsheetId);
  const existingNames = ss.getSheets().map(s => s.getName());
  // Tạo trước các sheet còn thiếu (bắt buộc phải dùng SpreadsheetApp cho việc tạo mới)
  tableNames.forEach(t => {
    if (existingNames.indexOf(t) === -1) {
      const headers = TABLES_SCHEMA[t];
      const sheet = ss.insertSheet(t);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      styleHeaderRow_(sheet, headers.length);
    }
  });

  let response;
  try {
    response = Sheets.Spreadsheets.Values.batchGet(spreadsheetId, {
      ranges: tableNames,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    console.log('batchGet OK cho ' + spreadsheetId + ' (' + tableNames.length + ' bảng, nhanh)');
  } catch (e) {
    console.log('batchGet LỖI, quay về cách đọc cũ (chậm): ' + e.message);
    // Advanced Service "Sheets" chưa được bật trong project -> quay về cách đọc cũ (chậm hơn nhưng vẫn chạy được)
    const result = {};
    tableNames.forEach(t => { result[t] = readTableData_(t); });
    return result;
  }

  const result = {};
  (response.valueRanges || []).forEach((vr, i) => {
    const table = tableNames[i];
    const headers = TABLES_SCHEMA[table];
    const values = vr.values || [];
    if (values.length === 0) { result[table] = []; return; }
    const existingHeaders = values[0];
    const same = existingHeaders.length === headers.length && headers.every((h, idx) => existingHeaders[idx] === h);
    if (!same) {
      const sheet = ss.getSheetByName(table);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      styleHeaderRow_(sheet, headers.length);
    }
    result[table] = rowsToObjectsFromApi_(values, headers);
  });
  return result;
}

/** Ghi 1 thay đổi (Thêm/Sửa/Xóa) vào bản NHÁP — KHÔNG đụng vào bản chính. Chỉ Nhân viên được cấp
 *  quyền thao tác (ChoPhepThaoTac) mới được gọi hàm này. Trả về id của dòng nháp vừa tạo. */
function saveDraftRow(table, row, action) {
  if (!TABLES_SCHEMA[table]) throw new Error('Bảng không tồn tại: ' + table);
  const me = getCurrentUserInfo();
  if (!me.canEdit) throw new Error('Bạn không có quyền thêm/sửa dữ liệu. Liên hệ Quản lý để được cấp quyền thao tác.');
  if (!row._id) row._id = uid_();
  const ss = getDraftSpreadsheet_();
  const headers = TABLES_SCHEMA[table].concat(DRAFT_META_HEADERS);
  const sheet = getOrCreateSheetIn_(ss, table, headers);
  let user = '';
  try { user = Session.getActiveUser().getEmail() || ''; } catch (e) { user = ''; }
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  const draftRowId = uid_();
  const payloadArray = TABLES_SCHEMA[table].map(h => (row[h] === undefined || row[h] === null) ? '' : row[h]);
  const metaArray = [draftRowId, 'Chờ duyệt', action, user, now, '', ''];
  sheet.appendRow(payloadArray.concat(metaArray));
  return { draftRowId: draftRowId, targetId: row._id };
}

/** Lấy toàn bộ bản nháp đang "Chờ duyệt" ở mọi bảng — dùng cho màn hình Duyệt. */
/** Lấy toàn bộ bản nháp đang "Chờ duyệt" ở mọi bảng — dùng cho màn hình Duyệt.
 *  Dùng batchGet gộp 1 lượt gọi API duy nhất cho tất cả bảng (thay vì đọc tuần tự từng bảng — rất chậm). */
function getPendingDrafts() {
  const ss = getDraftSpreadsheet_();
  const cfg = getConfig_();
  const existingNames = ss.getSheets().map(s => s.getName());
  DRAFT_TABLES.forEach(t => {
    if (existingNames.indexOf(t) === -1) {
      const headers = TABLES_SCHEMA[t].concat(DRAFT_META_HEADERS);
      const sheet = ss.insertSheet(t);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      styleHeaderRow_(sheet, headers.length);
    }
  });

  let response;
  try {
    response = Sheets.Spreadsheets.Values.batchGet(cfg.draftId, {
      ranges: DRAFT_TABLES,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
  } catch (e) {
    // Chưa bật Sheets API -> quay về cách đọc cũ (chậm hơn nhưng vẫn chạy được)
    const result = {};
    DRAFT_TABLES.forEach(table => {
      const headers = TABLES_SCHEMA[table].concat(DRAFT_META_HEADERS);
      const sheet = getOrCreateSheetIn_(ss, table, headers);
      const rows = sheetToObjects_(sheet).filter(r => r.TrangThaiDuyet === 'Chờ duyệt');
      if (rows.length) result[table] = rows;
    });
    return result;
  }

  const result = {};
  (response.valueRanges || []).forEach((vr, i) => {
    const table = DRAFT_TABLES[i];
    const headers = TABLES_SCHEMA[table].concat(DRAFT_META_HEADERS);
    const values = vr.values || [];
    if (values.length === 0) return;
    const rows = rowsToObjectsFromApi_(values, headers).filter(r => r.TrangThaiDuyet === 'Chờ duyệt');
    if (rows.length) result[table] = rows;
  });
  return result;
}

function findDraftRow_(table, draftRowId) {
  const ss = getDraftSpreadsheet_();
  const headers = TABLES_SCHEMA[table].concat(DRAFT_META_HEADERS);
  const sheet = getOrCreateSheetIn_(ss, table, headers);
  const values = sheet.getDataRange().getValues();
  const draftIdCol = headers.indexOf('DraftRowId');
  for (let r = 1; r < values.length; r++) {
    if (values[r][draftIdCol] === draftRowId) {
      const payload = {};
      TABLES_SCHEMA[table].forEach((h, i) => {
        let v = values[r][i];
        if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
        payload[h] = (v === '') ? undefined : v;
      });
      return { sheet, rowIndex: r + 1, headers, payload, action: values[r][headers.indexOf('HanhDong')] };
    }
  }
  return null;
}

function setDraftStatus_(sheet, headers, rowIndex, status) {
  let user = '';
  try { user = Session.getActiveUser().getEmail() || ''; } catch (e) { user = ''; }
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange(rowIndex, headers.indexOf('TrangThaiDuyet') + 1).setValue(status);
  sheet.getRange(rowIndex, headers.indexOf('NguoiDuyet') + 1).setValue(user);
  sheet.getRange(rowIndex, headers.indexOf('ThoiGianDuyet') + 1).setValue(now);
}

/** Đọc dòng MỚI NHẤT (Hiệu lực từ ngày lớn nhất) hiện có trong bản chính ứng với 1 _id — dùng để
 *  "vá" các trường không có trong payload gửi lên (VD: khi Hủy, client chỉ gửi {_id}), tránh ghi
 *  dòng lịch sử mới với các trường còn lại bị trống oan. */
function getLatestRowById_(table, id) {
  const sheet = getOrCreateSheet_(table);
  const rows = sheetToObjects_(sheet).filter(function (r) { return r._id === id; });
  if (rows.length === 0) return null;
  rows.sort(function (a, b) { return String(a.HieuLucTuNgay || '').localeCompare(String(b.HieuLucTuNgay || '')); });
  return rows[rows.length - 1];
}

// =====================================================================
// 5.5) LỊCH SỬ NHÂN SỰ — dùng cho màn "Chi tiết nhân sự / Lịch sử" (chọn NV + từ ngày-đến ngày)
// =====================================================================
// Bảng con trực tiếp của 1 nhân viên (_parentId = _id của DM_NHANVIEN)
const EMP_DIRECT_HISTORY_TABLES = ['CT_THONGTINCANHAN','CT_TRINHDOHOCVAN','CT_NHANTHAN','CT_THONGTINTHANHTOAN',
  'CT_SUCKHOE','CT_THONGTINLIENHE','CT_THONGTINNGHENGHIEP','CT_QUATRINHCONGTAC','CT_QUATRINHLAMVIEC'];
// Bảng con của từng hợp đồng lao động (_parentId = _id của CT_QUATRINHLAMVIEC)
const EMP_CONTRACT_HISTORY_TABLES = ['CT_KHAMSUCKHOE','CT_QUYENLOIPHEP','CT_NGHIPHEP','CT_NGHIOM',
  'CT_CHITIETHOPDONG','CT_NOIQUY','CT_KHENTHUONG','CT_TAILIEU'];

function pushHistoryEvent_(events, table, row, tuNgay, denNgay) {
  const d = row.HieuLucTuNgay || '';
  if (tuNgay && d && d < tuNgay) return;
  if (denNgay && d && d > denNgay) return;
  events.push({ table: table, row: row });
}

/** Lấy TOÀN BỘ lịch sử thay đổi (mọi phiên bản, KHÔNG lọc mới nhất) của 1 nhân viên trong khoảng
 *  [tuNgay, denNgay] theo "Hiệu lực từ ngày" — dùng cho màn "Chi tiết nhân sự / Lịch sử".
 *  tuNgay/denNgay dạng 'yyyy-MM-dd', truyền '' hoặc bỏ qua nghĩa là không giới hạn đầu/cuối. */
function getEmployeeHistory(empId, tuNgay, denNgay) {
  const me = getCurrentUserInfo();
  if (!me.role) throw new Error('Bạn chưa có quyền truy cập.');
  const cfg = getConfig_();
  if (!cfg) throw new Error('Chưa cấu hình liên kết Google Sheet. Hãy thiết lập trước.');
  const emp = getLatestRowById_('DM_NHANVIEN', empId);
  if (!emp) throw new Error('Không tìm thấy nhân viên.');

  const events = [];

  EMP_DIRECT_HISTORY_TABLES.forEach(function (table) {
    const rows = sheetToObjects_(getOrCreateSheet_(table)).filter(function (r) { return r._parentId === empId; });
    rows.forEach(function (r) { pushHistoryEvent_(events, table, r, tuNgay, denNgay); });
  });

  const hdldIdSet = {};
  sheetToObjects_(getOrCreateSheet_('CT_QUATRINHLAMVIEC'))
    .filter(function (r) { return r._parentId === empId; })
    .forEach(function (r) { hdldIdSet[r._id] = true; });

  EMP_CONTRACT_HISTORY_TABLES.forEach(function (table) {
    const rows = sheetToObjects_(getOrCreateSheet_(table)).filter(function (r) { return hdldIdSet[r._parentId]; });
    rows.forEach(function (r) { pushHistoryEvent_(events, table, r, tuNgay, denNgay); });
  });

  events.sort(function (a, b) { return String(a.row.HieuLucTuNgay || '').localeCompare(String(b.row.HieuLucTuNgay || '')); });
  return { employee: emp, events: events };
}

/** Ghi 1 thay đổi đã được duyệt vào bản chính.
 *  - DM_CONG / DM_NGUOIDUNG: giữ cách cũ — ghi đè tại chỗ (Thêm/Sửa) hoặc xoá vật lý (Hủy/Xóa).
 *  - Mọi bảng còn lại: KHÔNG BAO GIỜ ghi đè hay xoá vật lý — luôn APPEND 1 dòng mới, giữ NGUYÊN
 *    _id cũ (để _parentId của các bảng con vẫn trỏ đúng), gắn TrangThaiBanGhi = "Thêm mới"/"Sửa"/"Hủy",
 *    Hiệu lực từ ngày = giá trị người dùng nhập (nếu có) hoặc ngày duyệt, Hiệu lực đến ngày luôn để
 *    trống (= vô thời hạn) — công thức MINIFS sẽ tự tính lại Hiệu lực đến ngày của (các) dòng cũ hơn
 *    cùng _id thành đúng Hiệu lực từ ngày của dòng mới này. */
function commitChange_(table, payload, action) {
  const isHuy = (action === 'Hủy' || action === 'Xóa');
  if (SINGLETON_TABLES.indexOf(table) > -1 || table === 'DM_NGUOIDUNG') {
    if (isHuy) deleteRow(table, payload._id); else saveRow(table, payload);
    return;
  }
  const headers = TABLES_SCHEMA[table];
  const sheet = getOrCreateSheet_(table);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const trangThai = isHuy ? 'Hủy' : (action === 'Sửa' ? 'Sửa' : 'Thêm mới');
  // Vá các trường thiếu bằng dòng mới nhất hiện có, rồi mới áp payload đè lên — CHỈ áp dụng khi Hủy,
  // vì đó là trường hợp DUY NHẤT client cố ý gửi payload thiếu (chỉ {_id}, xem saveDraftRow ở client).
  // Khi Thêm/Sửa, form luôn gửi ĐỦ mọi trường (kể cả '' cho trường vừa bị xoá trắng) nên payload đã là
  // dữ liệu đầy đủ mới nhất — áp thẳng, không được lấy `current` để vá, nếu không sẽ không xoá trắng
  // được trường tuỳ chọn (findDraftRow_ đọc lại '' từ Sheet thành `undefined`, không phân biệt được với
  // "trường không gửi lên").
  const current = payload._id ? (getLatestRowById_(table, payload._id) || {}) : {};
  const row = Object.assign({}, current);
  if (isHuy) {
    Object.keys(payload).forEach(function (h) {
      if (payload[h] !== undefined) row[h] = payload[h];
    });
  } else {
    Object.assign(row, payload);
  }
  Object.assign(row, {
    TrangThaiBanGhi: trangThai,
    HieuLucTuNgay: payload.HieuLucTuNgay || today,
    HieuLucDenNgay: '',
  });
  if (!row._id) row._id = uid_();
  const rowArray = headers.map(function (h) { return (row[h] === undefined || row[h] === null) ? '' : row[h]; });
  sheet.appendRow(rowArray);
  applyComputedFormula_(table, sheet.getLastRow());
}

/** Duyệt 1 bản nháp — ghi thật vào bản chính (DM_CONGCTY_HAK / THONGTINNHANSU_HAK), rồi đánh dấu
 *  dòng nháp là "Đã duyệt". */
function approveDraft(table, draftRowId) {
  const me = getCurrentUserInfo();
  if (!me.canApprove) throw new Error('Bạn không có quyền duyệt.');
  const found = findDraftRow_(table, draftRowId);
  if (!found) throw new Error('Không tìm thấy bản nháp.');
  commitChange_(table, found.payload, found.action);
  setDraftStatus_(found.sheet, found.headers, found.rowIndex, 'Đã duyệt');
  return true;
}

/** Từ chối 1 bản nháp — KHÔNG ghi vào bản chính, chỉ đánh dấu trạng thái. */
function rejectDraft(table, draftRowId) {
  const me = getCurrentUserInfo();
  if (!me.canApprove) throw new Error('Bạn không có quyền duyệt.');
  const found = findDraftRow_(table, draftRowId);
  if (!found) throw new Error('Không tìm thấy bản nháp.');
  setDraftStatus_(found.sheet, found.headers, found.rowIndex, 'Từ chối');
  return true;
}

/** Nạp dữ liệu ban đầu hàng loạt — chỉ Admin. Ghi thẳng vào bản chính (không qua nháp, vì đây là
 *  bước khởi tạo dữ liệu lần đầu). dataByTable = { TÊN_BẢNG: [ {cột: giá trị, ...}, ... ] }. */
function bulkImportData(dataByTable) {
  const me = getCurrentUserInfo();
  if (!me.canAdmin) throw new Error('Chỉ Admin được tải dữ liệu ban đầu.');
  const summary = {};
  Object.keys(dataByTable || {}).forEach(table => {
    if (!TABLES_SCHEMA[table] || table === 'DM_NGUOIDUNG') return; // bỏ qua sheet lạ / không cho nạp người dùng qua đường này
    const rows = dataByTable[table];
    if (!Array.isArray(rows) || rows.length === 0) return;
    const headers = TABLES_SCHEMA[table];
    const arrays = rows.map(r => {
      if (!r._id) r._id = uid_();
      return headers.map(h => (r[h] === undefined || r[h] === null || r[h] === '') ? '' : r[h]);
    });
    const sheet = getOrCreateSheet_(table);
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, arrays.length, headers.length).setValues(arrays);
    applyFormulasToAllRows_(table); // tự tính lại "Hiệu lực đến" cho các bảng có versioning
    summary[table] = arrays.length;
  });
  return summary;
}

function saveRow(table, row) {
  if (!TABLES_SCHEMA[table]) throw new Error('Bảng không tồn tại: ' + table);
  const sheet = getOrCreateSheet_(table);
  const headers = TABLES_SCHEMA[table];
  const values = sheet.getDataRange().getValues();

  let rowIndex = -1;
  if (SINGLETON_TABLES.indexOf(table) > -1) {
    // Bảng chỉ 1 dòng (VD: DM_CONG) — luôn ghi vào dòng 2, không quan tâm _id gửi lên.
    rowIndex = values.length > 1 ? 2 : -1;
    if (!row._id) row._id = uid_();
  } else {
    for (let r = 1; r < values.length; r++) {
      if (values[r][0] === row._id) { rowIndex = r + 1; break; }
    }
  }

  const rowArray = headers.map(h => (row[h] === undefined || row[h] === null) ? '' : row[h]);
  let targetRow;
  if (rowIndex > -1) {
    sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowArray]);
    targetRow = rowIndex;
  } else {
    sheet.appendRow(rowArray);
    targetRow = sheet.getLastRow();
  }
  applyComputedFormula_(table, targetRow);
  return true;
}

function deleteRow(table, id) {
  if (!TABLES_SCHEMA[table]) throw new Error('Bảng không tồn tại: ' + table);
  const sheet = getOrCreateSheet_(table);
  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (values[r][0] === id) { sheet.deleteRow(r + 1); break; }
  }
  return true;
}

function uid_() {
  return 'id_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

// =====================================================================
// 6) SEED — danh mục thật (đồng bộ từ HAKDN_DanhMuc.xlsx)
// =====================================================================
function seedRealDanhMucIfEmpty_() {
  const sheet = getOrCreateSheet_('DM_CHUCVU');
  if (sheet.getLastRow() > 1) return false; // đã có dữ liệu — không seed lại
  seedRealDanhMuc();
  return true;
}

/** Có thể chạy tay từ trình soạn thảo (Run > seedRealDanhMuc) để nạp lại danh mục thật. */
function seedRealDanhMuc() {
  const NOW = '2026-07-29';
  const NOW2 = '2025-09-01'; // Ngày cập nhật thật lấy từ file dm_congty.xlsx

  appendRows_('DM_CHUCVU', [
    [uid_(),NOW2,'1','Giám đốc',NOW2],
    [uid_(),NOW2,'2','Phó giám đốc',NOW2],
    [uid_(),NOW2,'3','Quản đốc PX',NOW2],
    [uid_(),NOW2,'4','Trưởng bộ phận',NOW2],
    [uid_(),NOW2,'5','Tổ trưởng',NOW2],
    [uid_(),NOW2,'6','Nhân viên bậc 1',NOW2],
    [uid_(),NOW2,'7','Nhân viên bậc 2',NOW2],
    [uid_(),NOW2,'8','Công nhân bậc 1',NOW2],
    [uid_(),NOW2,'9','Công nhân bậc 2',NOW2],
  ]);

  appendRows_('DM_PHONGBAN', [
    [uid_(),NOW2,'01','Văn phòng','01.01','Văn phòng',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.02','Trạm cân',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.03','Quản đốc',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.04','Tạp vụ',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.05','Bảo vệ',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.06','Kinh doanh',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.07','KCS',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.08','Cơ khí',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.09','Cơ giới',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.10','Thủ kho',NOW2],
    [uid_(),NOW2,'01','Văn phòng','01.11','Ben hàng',NOW2],
    [uid_(),NOW2,'02','Sản xuất','02.01','Tổ 1 - Công nhân sản xuất',NOW2],
    [uid_(),NOW2,'02','Sản xuất','02.02','Tổ 2 - Công nhân sản xuất',NOW2],
    [uid_(),NOW2,'02','Sản xuất','02.03','Tổ 1 - Công nhân công nhật',NOW2],
    [uid_(),NOW2,'02','Sản xuất','02.04','Tổ 2 - Công nhân công nhật',NOW2],
  ]);

  appendRows_('DM_LUONG', [
    [uid_(),NOW2,'CĐ','LTG','Lương cố định',0,'Cố định',0,NOW2],
    [uid_(),NOW2,'TG1','LTG','Lương thời gian 1',0,'Số ngày của tháng - tất cả ngày CN',0,NOW2],
    [uid_(),NOW2,'TG2','LTG','Lương thời gian 2',0,'Số ngày của tháng',0,NOW2],
    [uid_(),NOW2,'TG3','LTG','Lương thời gian 3',0,'Số ngày của tháng - 4',4,NOW2],
    [uid_(),NOW2,'TG4','LTG','Lương thời gian 4',0,'Số ngày của tháng - 2',2,NOW2],
    [uid_(),NOW2,'CN1','LTG','Lương công nhật',0,'Thực tế ngày công',0,NOW2],
    [uid_(),NOW2,'CN2','LTG','Lương công nhật 2',0,'Thực tế ngày công',4,NOW2],
    [uid_(),NOW2,'SP','LSP','Lương sản phẩm',6000,'Nhân với sản lượng',0,NOW2],
    [uid_(),NOW2,'BD','LSP','Lương ban dăm',10000,'Nhân với sản lượng',0,NOW2],
  ]);

  appendRows_('DM_PHUCAP', [
    [uid_(),NOW2,'TN.01','Phụ cấp trách nhiệm BP Cơ khí',300000,0,0,
      'Tổng công >= công chuẩn tính đủ 300k, nhỏ hơn =300k/công chuẩn*tổng công',NOW2],
    [uid_(),NOW2,'TN.02','Phụ cấp trách nhiệm BP SX',200000,0,5,
      'Tổng công >= (công chuẩn-5) tính đủ 200k , nhỏ hơn =200k/công chuẩn*tổng công',NOW2],
    [uid_(),NOW2,'TN.03','Phụ cấp trách nhiệm Quản lý',1000000,0,0,'Cố định hàng tháng',NOW2],
    [uid_(),NOW2,'TN.04','Phụ cấp trách nhiệm BP Kinh doanh',570000,0,0,'Cố định hàng tháng',NOW2],
    [uid_(),NOW2,'QC','Phụ cấp công tác HAKQN',100000,0,0,'',NOW2],
    [uid_(),NOW2,'QS','Phụ cấp công tác CNHAK',120000,0,0,'',NOW2],
    [uid_(),NOW2,'ĐH','Phụ cấp công tác ĐH',30000,0,0,'',NOW2],
    [uid_(),NOW2,'ĐN','Phụ cấp công tác Đà Nẵng',120000,0,0,'',NOW2],
    [uid_(),NOW2,'DQ','Phụ cấp công tác DQ',500000,0,0,'Phụ cấp công tác',NOW2],
    [uid_(),NOW2,'SX','Phụ cấp sửa xe',200000,0,0,'Phụ cấp sửa xe',NOW2],
  ]);

  appendRows_('DM_TANGCA', [
    [uid_(),NOW2,'TC1','Tăng ca tính theo tháng loại 1',0.5,0,
      '(Công tính lương- Công lễ- công trung chuyển-ngày phép-công tăng ca-công chuẩn)*hệ số tăng ca+công tăng ca*hệ số tăng ca',NOW2],
    [uid_(),NOW2,'TC2','Tăng ca tính theo tháng loại 2',0.5,0,
      '(Công tính lương- Công lễ- công trung chuyển-ngày phép-công tăng ca-công di chuyển-công chuẩn)*hệ số tăng ca+công tăng ca*hệ số tăng ca',NOW2],
    [uid_(),NOW2,'TC3','Tăng ca tính theo công và chủ nhật',0.5,0,'(Công tăng ca +Công chủ nhật)*hệ số tăng ca',NOW2],
    [uid_(),NOW2,'TC4','Tăng ca tính theo công',0.5,0,'Công tăng ca*hệ số tăng ca',NOW2],
    [uid_(),NOW2,'TC5','Ca làm thêm vị trí khác',1,6000000,'Lương làm ca khác',NOW2],
  ]);

  appendRows_('DM_HOTRO', [
    [uid_(),NOW2,'HT.01','Tiền cơm',20000,'Số tiền * Số ngày công',NOW2],
    [uid_(),NOW2,'HT.02','Hỗ trợ lương cơ giới',150000,'Nếu công thực tế <công chuẩn = (công chuẩn - công thực tế) *150.000',NOW2],
  ]);

  appendRows_('DM_CC', [
    [uid_(),NOW2,'CTL','Công tính lương','BT','Công hàng ngày',NOW2],
    [uid_(),NOW2,'CTL','Công tính lương','PN','Công ngày phép',NOW2],
    [uid_(),NOW2,'CTL','Công tính lương','CL','Công ngày lễ',NOW2],
    [uid_(),NOW2,'CTL','Công tính lương','TRCH','Công trung chuyển hàng',NOW2],
    [uid_(),NOW2,'CTL','Công tính lương','DC','Công di chuyển',NOW2],
    [uid_(),NOW2,'CTTC','Công tính tăng ca','TC','Công tăng ca',NOW2],
    [uid_(),NOW2,'CTHT','Công tính hỗ trợ','CC','Ngày tính tiền cơm',NOW2],
    [uid_(),NOW2,'CTPC','Công tính phụ cấp','CT','Công công tác',NOW2],
  ]);

  appendRows_('DM_BAOHIEM', [
    [uid_(),'BH01','Đóng đầy đủ BHXH/BHYT/BHTN/KPCĐ',0.175,0.03,0.01,0.02,0.08,0.015,0.01,0,NOW],
    [uid_(),'BH00','Không tham gia BHXH (thử việc/thời vụ ngắn)',0,0,0,0,0,0,0,0,NOW],
  ]);

  const tncnVL = uid_(), tncnLT = uid_();
  appendRows_('DM_TNCN', [
    [tncnVL,'VL01','Khấu trừ vãng lai',0.10,
      'Khấu trừ 10% trước khi trả thu nhập, áp dụng khi trả ≥5.000.000đ/lần cho cá nhân không ký HĐLĐ hoặc HĐLĐ dưới 3 tháng (trừ khi có cam kết 08/CK-TNCN). Căn cứ: Nghị định 253/2026/NĐ-CP.',
      '2026-07-01'],
    [tncnLT,'LT01','Lũy tiến','',
      'Áp dụng cho thu nhập từ tiền lương, tiền công theo HĐLĐ từ 3 tháng trở lên. Xem chi tiết tại bảng bậc thuế (CT_BACTHUE_TNCN). Căn cứ: Luật Thuế TNCN 2025 số 109/2025/QH15, biểu thuế 5 bậc từ kỳ tính thuế 2026.',
      '2026-01-01'],
  ]);

  appendRows_('CT_BACTHUE_TNCN', [
    [uid_(),tncnLT,1,0,10000000,0.05],
    [uid_(),tncnLT,2,10000000,30000000,0.10],
    [uid_(),tncnLT,3,30000000,60000000,0.20],
    [uid_(),tncnLT,4,60000000,100000000,0.30],
    [uid_(),tncnLT,5,100000000,0,0.35],
  ]);

  appendRows_('DM_GT_TNCN', [
    [uid_(),'GTBT.01',1,11000000,'2020-07-01'],
    [uid_(),'GTNPT.01',1,4400000,'2020-07-01'],
    [uid_(),'GTBT.01',1,15500000,'2026-01-01'],
    [uid_(),'GTNPT.01',1,6200000,'2026-01-01'],
  ]);

  ['DM_CHUCVU','DM_PHONGBAN','DM_LUONG','DM_PHUCAP','DM_TANGCA','DM_HOTRO','DM_BAOHIEM',
   'DM_TNCN','DM_GT_TNCN','CT_BACTHUE_TNCN','DM_CC'].forEach(applyFormulasToAllRows_);
  fillMissingTrangThaiBanGhi_();
}

function appendRows_(table, rows) {
  const sheet = getOrCreateSheet_(table);
  if (rows.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
}

// =====================================================================
// 7) SEED — 1 nhân viên mẫu (tham chiếu đúng danh mục thật ở trên)
// =====================================================================
function seedDemoEmployee() {
  ensureAllSheets_();
  seedRealDanhMucIfEmpty_();

  const findByCode = (table, codeField, code) =>
    sheetToObjects_(getOrCreateSheet_(table)).find(r => r[codeField] === code);

  const cvCN = findByCode('DM_CHUCVU', 'MaCV', '8'); // Công nhân bậc 1
  const pbSX = findByCode('DM_PHONGBAN', 'MaPB', '02.01'); // Tổ 1 - Công nhân sản xuất
  const luongSP = findByCode('DM_LUONG', 'MaLuong', 'SP'); // Lương sản phẩm
  const baoHiemDu = findByCode('DM_BAOHIEM', 'MaBaoHiem', 'BH01');
  const tncnLT = findByCode('DM_TNCN', 'MaThueTNCN', 'LT01');

  const now = new Date();
  const y = now.getFullYear();
  const fmtDate = d => Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const empId = uid_();
  appendRows_('DM_NHANVIEN', [[empId,'NV001','Nguyễn Văn An','079123456789',fmtDate(now),'Đang làm việc']]);

  const bdaySoon = new Date(now); bdaySoon.setDate(bdaySoon.getDate() + 10);
  const bdayStr = (y - 30) + '-' + ('0' + (bdaySoon.getMonth()+1)).slice(-2) + '-' + ('0' + bdaySoon.getDate()).slice(-2);
  appendRows_('CT_THONGTINCANHAN', [[uid_(),empId,'079123456789','2021-05-10','Cục Cảnh sát QLHC về TTXH',
    bdayStr,'Nam','Việt Nam','Kinh','Đã kết hôn','123 Lê Lợi, Q.1, TP.HCM','123 Lê Lợi, Q.1, TP.HCM','0901234567','2021-05-10']]);

  appendRows_('CT_NHANTHAN', [[uid_(),empId,'Nguyễn Văn Bảo','Con','','','','8801234567',true,'2022-03-01']]);
  appendRows_('CT_THONGTINTHANHTOAN', [[uid_(),empId,'0071001234567','Vietcombank','CN TP.HCM','2021-05-01']]);
  appendRows_('CT_SUCKHOE', [[uid_(),empId,'Không có','Bình thường','2021-05-01']]);
  appendRows_('CT_QUATRINHCONGTAC', [[uid_(),empId,'2021-05-10','',pbSX?pbSX._id:'',cvCN?cvCN._id:'','Bổ nhiệm','Tuyển dụng ban đầu']]);

  const hdldId = uid_();
  const expireSoon = new Date(now); expireSoon.setDate(expireSoon.getDate() + 20);
  appendRows_('CT_QUATRINHLAMVIEC', [[hdldId,empId,'HDLD-2021-001','2021-05-10',fmtDate(expireSoon),
    'Xác định thời hạn','2021-05-10','Hợp đồng 3 năm, sắp đến hạn tái ký']]);
  appendRows_('CT_NGHIPHEP', [[uid_(),hdldId,y+'-03-04',y+'-03-05',2,'Đã duyệt','Trần Thị Hoa','Nghỉ phép năm']]);

  const hopdongId = uid_();
  appendRows_('CT_CHITIETHOPDONG', [[hopdongId,hdldId,'CT-2021-01','2021-05-10','',
    pbSX?pbSX._id:'',cvCN?cvCN._id:'','LSP',luongSP?luongSP._id:'',4680000,6000000,'Chuyển khoản',
    baoHiemDu?baoHiemDu._id:'',tncnLT?tncnLT._id:'','','','',
    'Hợp đồng gốc','2021-05-10','']]);
  appendRows_('CT_NOIQUY', [[uid_(),hopdongId,y+'-04-02','Đi trễ 3 lần trong tháng','Đang xử lý','Nhắc nhở bằng văn bản']]);

  ['CT_QUATRINHCONGTAC','CT_QUATRINHLAMVIEC','CT_NGHIPHEP','CT_CHITIETHOPDONG','CT_NOIQUY',
   'CT_THONGTINCANHAN','CT_NHANTHAN','CT_THONGTINTHANHTOAN','CT_SUCKHOE','DM_NHANVIEN']
    .forEach(applyFormulasToAllRows_);
  fillMissingTrangThaiBanGhi_();

  return true;
}
