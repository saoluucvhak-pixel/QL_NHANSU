'use strict';
/**
 * Môi trường giả lập tối thiểu cho Google Apps Script, đủ để nạp và chạy TRỰC TIẾP
 * mã nguồn thật trong Code.gs bằng Node (qua vm), không cần sửa Code.gs.
 *
 * Chủ đích KHÔNG mock "Sheets" (Advanced Service) — mọi nơi trong Code.gs gọi
 * Sheets.Spreadsheets.Values.batchGet(...) đều đã có try/catch để tự rơi về cách đọc
 * chậm hơn qua SpreadsheetApp khi Advanced Service chưa bật. Để trống "Sheets" khiến
 * test luôn đi qua đúng nhánh fallback đó — giống một project mới chưa bật Advanced
 * Service — và nhờ vậy cũng test luôn được readTableData_/sheetToObjects_.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_GS_PATH = path.join(__dirname, '..', '..', 'Code.gs');

function pad(n) { return String(n).padStart(2, '0'); }

function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function cellRaw(sheet, row, col) {
  const r = sheet.data[row - 1] || [];
  const v = r[col - 1];
  return v === undefined ? '' : v;
}

/** "Tính" 2 dạng công thức mà Code.gs (applyComputedFormula_) thực sự sinh ra:
 *   - hieuLucDenFormula_  : =IFERROR(MINIFS(<tuCol>2:<tuCol>2000,<codeCol>2:<codeCol>2000,<codeCol>N,<tuCol>2:<tuCol>2000,">"&<tuCol>N),"")
 *   - mucDongToiDaFormula_: =IF(<denCol>N=0,0,(<denCol>N-<tuCol>N)*<tyCol>N)
 * FakeRange chỉ lưu chuỗi công thức (không có formula engine thật của Google Sheets), nên phải tự
 * diễn giải lại đúng 2 dạng trên khi đọc giá trị — nếu không, mọi test đọc lại các cột tính tự động
 * (HieuLucDenNgay, MucDongToiDaBac) sẽ thấy nguyên văn chuỗi công thức thay vì giá trị thật.
 */
function evaluateFormula(sheet, formula) {
  // Không dùng backreference kiểu \12 (rất dễ bị JS hiểu nhầm thành "backreference nhóm 12" thay vì
  // "\1" + literal "2") — tách trực tiếp danh sách tham số của MINIFS(...) rồi tự đọc cột/dòng.
  const m1 = formula.match(/^=IFERROR\(MINIFS\((.+)\),""\)$/);
  if (m1) {
    const args = m1[1].split(',');
    const codeCellRef = args[2].match(/^([A-Za-z]+)(\d+)$/);
    const tuColRef = args[0].match(/^([A-Za-z]+)\d+:/);
    const tuCol = colLettersToIndex(tuColRef[1]);
    const codeCol = colLettersToIndex(codeCellRef[1]);
    const rowNum = parseInt(codeCellRef[2], 10);
    const codeVal = cellRaw(sheet, rowNum, codeCol);
    const tuVal = cellRaw(sheet, rowNum, tuCol);
    let min = null;
    for (let r = 2; r <= sheet.data.length; r++) {
      const c = cellRaw(sheet, r, codeCol);
      const t = cellRaw(sheet, r, tuCol);
      if (c === codeVal && t !== '' && String(t) > String(tuVal)) {
        if (min === null || String(t) < String(min)) min = t;
      }
    }
    return min === null ? '' : min;
  }
  const m2 = formula.match(/^=IF\(([A-Za-z]+)(\d+)=0,0,\(\1\2-([A-Za-z]+)\2\)\*([A-Za-z]+)\2\)$/);
  if (m2) {
    const denCol = colLettersToIndex(m2[1]);
    const rowNum = parseInt(m2[2], 10);
    const tuCol = colLettersToIndex(m2[3]);
    const tyCol = colLettersToIndex(m2[4]);
    const den = Number(cellRaw(sheet, rowNum, denCol)) || 0;
    const tu = Number(cellRaw(sheet, rowNum, tuCol)) || 0;
    const ty = Number(cellRaw(sheet, rowNum, tyCol)) || 0;
    return den === 0 ? 0 : (den - tu) * ty;
  }
  return formula; // dạng công thức lạ (không dùng trong Code.gs hiện tại) — trả nguyên văn để dễ nhận ra khi test sai
}

function makeUtilities(state) {
  return {
    getUuid() {
      state.uuidCounter += 1;
      // uid_() trong Code.gs lấy 12 KÝ TỰ ĐẦU của uuid sau khi bỏ dấu "-", nên số đếm phải nằm
      // trong 2 nhóm đầu (8+4 ký tự) chứ không phải nhóm cuối, nếu không mọi id sinh ra sẽ giống hệt
      // nhau (luôn là phần "00000000-0000-" cố định) — từng khiến các test đụng độ _id/DraftRowId.
      const hex = state.uuidCounter.toString(16).padStart(12, '0');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-000000000000`;
    },
    formatDate(date, tz, fmt) {
      const d = date instanceof Date ? date : new Date(date);
      const y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
      const h = pad(d.getUTCHours()), mi = pad(d.getUTCMinutes()), se = pad(d.getUTCSeconds());
      if (fmt === 'yyyy-MM-dd') return `${y}-${mo}-${da}`;
      if (fmt === 'yyyy-MM-dd HH:mm:ss') return `${y}-${mo}-${da} ${h}:${mi}:${se}`;
      return d.toISOString();
    },
    base64Decode(s) { return Array.from(Buffer.from(s, 'base64')); },
    base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
    newBlob(bytes, mimeType, name) { return { bytes, mimeType, name }; },
  };
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const srcRow = this.sheet.data[this.row - 1 + r] || [];
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        let v = srcRow[this.col - 1 + c];
        if (v === undefined) v = '';
        if (typeof v === 'string' && v.charAt(0) === '=') v = evaluateFormula(this.sheet, v);
        rowArr.push(v);
      }
      out.push(rowArr);
    }
    return out;
  }
  setValues(vals) {
    for (let r = 0; r < vals.length; r++) {
      const idx = this.row - 1 + r;
      if (!this.sheet.data[idx]) this.sheet.data[idx] = [];
      for (let c = 0; c < vals[r].length; c++) {
        this.sheet.data[idx][this.col - 1 + c] = vals[r][c];
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFormula(f) {
    if (!this.sheet.data[this.row - 1]) this.sheet.data[this.row - 1] = [];
    this.sheet.data[this.row - 1][this.col - 1] = f;
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.data.length - 1; r >= 0; r--) {
      const row = this.data[r] || [];
      if (row.some(v => v !== undefined && v !== '' && v !== null)) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach(row => { if (row) max = Math.max(max, row.length); });
    return max;
  }
  getMaxRows() { return Math.max(this.data.length, 1000); }
  getDataRange() {
    const lastRow = Math.max(this.data.length, this.getLastRow());
    return new FakeRange(this, 1, 1, lastRow, this.getLastColumn() || 1);
  }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }
  appendRow(arr) { this.data.push(arr.slice()); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  deleteRows(start, count) { this.data.splice(start - 1, count); }
  setFrozenRows() {}
  autoResizeColumns() {}
}

class FakeSpreadsheet {
  constructor(id) { this.id = id; this.sheets = {}; this.order = []; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const s = new FakeSheet(name);
    this.sheets[name] = s; this.order.push(name);
    return s;
  }
  getSheets() { return this.order.map(n => this.sheets[n]); }
  deleteSheet(sheet) {
    delete this.sheets[sheet.getName()];
    this.order = this.order.filter(n => n !== sheet.getName());
  }
  getId() { return this.id; }
}

function createGasEnv(opts = {}) {
  const state = {
    uuidCounter: 0,
    scriptProps: {},
    spreadsheets: {},
    currentUserEmail: opts.userEmail || 'saoluucvhak@gmail.com',
  };

  const SpreadsheetApp = {
    openById(id) {
      if (!state.spreadsheets[id]) state.spreadsheets[id] = new FakeSpreadsheet(id);
      return state.spreadsheets[id];
    },
  };
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: k => (k in state.scriptProps ? state.scriptProps[k] : null),
        setProperty: (k, v) => { state.scriptProps[k] = v; },
        deleteProperty: k => { delete state.scriptProps[k]; },
      };
    },
  };
  const Session = {
    getActiveUser: () => ({ getEmail: () => state.currentUserEmail }),
    getScriptTimeZone: () => 'Etc/UTC',
  };
  const DriveApp = {
    createFolder: name => ({ getId: () => 'folder_' + name, getUrl: () => 'https://drive/folder' }),
    getFolderById: () => { throw new Error('no such folder in fake DriveApp'); },
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
  };
  const ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }) };

  // Giả lập tối thiểu Advanced Drive Service (v3) — chỉ phần Permissions dùng bởi
  // listDataSharing/shareDataAccess/revokeDataAccess. Lưu ý tên phương thức thật của Apps Script
  // là "remove" (không phải "delete", vì "delete" là từ khoá dành riêng trong JS) — cố tình đặt tên
  // y hệt ở đây để bug gõ nhầm (nếu có) trong Code.gs sẽ lộ ra qua test thay vì chỉ vỡ khi chạy thật.
  state.drivePermissions = {}; // fileId -> [{id, type, role, emailAddress, displayName}]
  state.drivePermIdCounter = 0;
  // state.drivePageSize (mặc định không giới hạn): đặt 1 số nhỏ trong test để giả lập Drive API v3
  // trả kết quả theo nhiều trang (nextPageToken) — dùng để kiểm tra listAllPermissions_ có tự đi hết
  // các trang hay không, thay vì chỉ đọc trang đầu.
  // state.driveFailFileIds (Set, mặc định rỗng): fileId nào có trong set này sẽ khiến
  // create/update/remove ném lỗi — dùng để giả lập 1 trong 3 sheet lỗi giữa chừng (VD Drive API
  // rate-limit) và kiểm tra runOnAllDataSheets_ vẫn áp dụng cho 2 sheet còn lại + báo lỗi rõ ràng.
  state.driveFailFileIds = new Set();
  const Drive = {
    Permissions: {
      list(fileId, optionalArgs) {
        const all = state.drivePermissions[fileId] || [];
        const pageSize = state.drivePageSize || Infinity;
        const start = (optionalArgs && optionalArgs.pageToken) ? parseInt(optionalArgs.pageToken, 10) : 0;
        const pageItems = all.slice(start, start + pageSize).map(p => Object.assign({}, p));
        const nextStart = start + pageSize;
        const result = { permissions: pageItems };
        if (nextStart < all.length) result.nextPageToken = String(nextStart);
        return result;
      },
      create(resource, fileId) {
        if (state.driveFailFileIds.has(fileId)) throw new Error(`Fake Drive: lỗi giả lập trên file ${fileId}`);
        if (!state.drivePermissions[fileId]) state.drivePermissions[fileId] = [];
        state.drivePermIdCounter += 1;
        const perm = Object.assign({ id: 'perm_' + state.drivePermIdCounter }, resource);
        state.drivePermissions[fileId].push(perm);
        return Object.assign({}, perm);
      },
      update(resource, fileId, permissionId) {
        if (state.driveFailFileIds.has(fileId)) throw new Error(`Fake Drive: lỗi giả lập trên file ${fileId}`);
        const perm = (state.drivePermissions[fileId] || []).find(p => p.id === permissionId);
        if (!perm) throw new Error(`Fake Drive: permission ${permissionId} không tồn tại trên file ${fileId}`);
        Object.assign(perm, resource);
        return Object.assign({}, perm);
      },
      remove(fileId, permissionId) {
        if (state.driveFailFileIds.has(fileId)) throw new Error(`Fake Drive: lỗi giả lập trên file ${fileId}`);
        const list = state.drivePermissions[fileId] || [];
        state.drivePermissions[fileId] = list.filter(p => p.id !== permissionId);
      },
    },
  };
  const HtmlService = {
    createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; } }) }),
    createHtmlOutputFromFile: () => ({ getContent: () => '' }),
  };

  const sandbox = {
    console,
    SpreadsheetApp,
    PropertiesService,
    Utilities: makeUtilities(state),
    Session,
    DriveApp,
    Drive,
    ScriptApp,
    HtmlService,
  };
  const context = vm.createContext(sandbox);

  const source = fs.readFileSync(CODE_GS_PATH, 'utf8');
  const expose = `
;globalThis.__EXPORTS__ = {
  TABLES_SCHEMA, VERSIONED_TABLES, SINGLETON_TABLES, COMPANY_TABLES, NHANSU_TABLES,
  DRAFT_TABLES, DRAFT_META_HEADERS, CONFIG_KEY, ADMIN_EMAIL, DEFAULT_CONFIG,
};
`;
  vm.runInContext(source + '\n' + expose, context, { filename: 'Code.gs' });

  return {
    context,
    state,
    exports: context.__EXPORTS__,
    setCurrentUser(email) { state.currentUserEmail = email; },
    getSpreadsheet(id) { return SpreadsheetApp.openById(id); },
    /** Seed sẵn 1 permission (thường dùng để giả lập owner có sẵn trên file) trước khi test. */
    seedPermission(fileId, perm) {
      if (!state.drivePermissions[fileId]) state.drivePermissions[fileId] = [];
      state.drivePermIdCounter += 1;
      state.drivePermissions[fileId].push(Object.assign({ id: 'perm_' + state.drivePermIdCounter }, perm));
    },
  };
}

/** Thiết lập nhanh 1 môi trường đã saveConfig() xong với 3 spreadsheet giả (id cố định, dễ debug). */
function createConfiguredGasEnv(opts = {}) {
  const env = createGasEnv(opts);
  const congTyId = 'congty123', nhanSuId = 'nhansu456', draftId = 'draft789';
  env.context.saveConfig(
    `https://docs.google.com/spreadsheets/d/${congTyId}/edit`,
    `https://docs.google.com/spreadsheets/d/${nhanSuId}/edit`,
    `https://docs.google.com/spreadsheets/d/${draftId}/edit`,
  );
  return Object.assign(env, { congTyId, nhanSuId, draftId });
}

module.exports = { createGasEnv, createConfiguredGasEnv, FakeSheet, FakeSpreadsheet };
