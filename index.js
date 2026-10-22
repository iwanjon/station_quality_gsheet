require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

// ==========================================
// 1. CONFIGURATION & ENVIRONMENT VARIABLES
// ==========================================
const KEY_FILE = process.env.GOOGLE_KEY_FILE;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:9090';
const DEBUG_STATION_CODE = process.env.DEBUG_STATION_CODE || '';

// Logger utility with ISO timestamps and levels
const log = {
  info: (tag, msg) => console.log(`[${new Date().toISOString()}] [INFO]  [${tag}] ${msg}`),
  warn: (tag, msg) => console.warn(`[${new Date().toISOString()}] [WARN]  [${tag}] ${msg}`),
  error: (tag, msg, err = null) => {
    console.error(`[${new Date().toISOString()}] [ERROR] [${tag}] ${msg}`);
    if (err) {
      if (err.isAxiosError) {
        console.error(`[${new Date().toISOString()}] [AXIOS DETAILS] URL: ${err.config?.url} | Status: ${err.response?.status || 'NO_RESPONSE'} | Data: ${JSON.stringify(err.response?.data || {})}`);
      } else if (err.errors) {
        console.error(`[${new Date().toISOString()}] [GOOGLE API DETAILS] Code: ${err.code} | Errors: ${JSON.stringify(err.errors)}`);
      }
      if (err.stack) console.error(`[${new Date().toISOString()}] [STACK TRACE]\n${err.stack}`);
    }
  },
  debug: (tag, msg) => console.log(`[${new Date().toISOString()}] [DEBUG] [${tag}] ${msg}`)
};

if (!KEY_FILE || !SPREADSHEET_ID) {
  log.error('CONFIG', 'Variabel GOOGLE_KEY_FILE dan SPREADSHEET_ID wajib diatur di dalam file .env');
  process.exit(1);
}

log.info('CONFIG', `Inisialisasi konfigurasi: SPREADSHEET_ID=${SPREADSHEET_ID}, API_BASE_URL=${API_BASE_URL}, KEY_FILE=${KEY_FILE}`);

const PIC_MAPPING = {
  "Clara Janie Frica": ["Sumatera Utara", "Sumatera Barat", "Jambi", "Bengkulu", "Aceh"],
  "Arya Bani Pangestu": ["Jawa Timur", "Jawa Tengah", "Yogyakarta", "Banten", "Jawa Barat", "Jakarta"],
  "Iwan Affandi Wijaya": ["Bali", "Kalimantan Timur", "Kalimantan Barat", "Kalimantan Utara", "Kalimantan Tengah", "Kalimantan Selatan", "Nusa Tenggara Timur", "Nusa Tenggara Barat", "Riau", "Kepulauan Riau"],
  "Handi Sulistyo Widodo": ["Lampung", "Sulawesi Utara", "Sulawesi Barat", "Sulawesi Selatan", "Sulawesi Tengah", "Sulawesi Tenggara", "Gorontalo"],
  "Aprilyanto": ["Sumatera Selatan", "Maluku", "Bangka Belitung", "Papua Selatan", "Maluku Utara", "Papua Barat", "Papua"]
};

function formatDate(date, format) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (format === "yyyy-MM-dd") return `${year}-${month}-${day}`;
  if (format === "dd-MM-yyyy") return `${day}-${month}-${year}`;
  return `${year}-${month}-${day}`;
}

async function buatSheetHarian() {
  console.time("Total Execution Time");
  log.info('START', '================ MEMULAI EKSEKUSI QC MONITORING ================');

  // ==========================================
  // AUTHENTICATION
  // ==========================================
  log.info('AUTH', `Memverifikasi file kredensial Google Service Account di: ${KEY_FILE}`);
  let sheets;
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    log.info('AUTH', 'Google Sheets Client berhasil diinisialisasi.');
  } catch (authErr) {
    log.error('AUTH', 'Gagal memuat kredensial Google API!', authErr);
    console.timeEnd("Total Execution Time");
    return;
  }

  try {
    // ==========================================
    // 2. DATE SETUP
    // ==========================================
    log.info('DATE', 'Menghitung rentang tanggal target (H-8 sampai H-2)...');
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(now.getUTCDate() - 1);
    const sheetName = formatDate(yesterday, "dd-MM-yyyy");

    log.info('DATE', `Target sheet name (H-1): "${sheetName}"`);

    // Verify existing sheets
    log.info('SHEET_CHECK', `Mengambil metadata spreadsheet ID: ${SPREADSHEET_ID}...`);
    const spreadsheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existingSheets = spreadsheetMeta.data.sheets.map(s => s.properties.title);
    log.info('SHEET_CHECK', `Daftar tab sheet saat ini (${existingSheets.length}): [${existingSheets.join(', ')}]`);

    if (existingSheets.includes(sheetName)) {
      log.warn('SHEET_CHECK', `[ABORT] Sheet "${sheetName}" sudah ada di spreadsheet. Proses dibatalkan untuk menghindari duplikasi data.`);
      console.timeEnd("Total Execution Time");
      return;
    }
    log.info('SHEET_CHECK', `Sheet "${sheetName}" belum ada. Melanjutkan proses.`);

    const datesToFetch = [];
    for (let i = 8; i >= 2; i--) {
      let d = new Date(now);
      d.setUTCDate(now.getUTCDate() - i);
      const label = formatDate(d, "dd-MM-yyyy");
      const apiDate = formatDate(d, "yyyy-MM-dd");
      datesToFetch.push({ label, apiDate, offsetDays: i });
      log.debug('DATE_SETUP', `Slot tanggal: H-${i} -> Label: ${label} | Format API: ${apiDate}`);
    }

    const targetAvailabilityDate = datesToFetch[datesToFetch.length - 1].apiDate;
    log.info('DATE', `Rentang tanggal final: ${datesToFetch[0].label} (tertua) s/d ${datesToFetch[datesToFetch.length - 1].label} (terbaru)`);
    log.info('DATE', `Target tanggal korelasi Availability (H-2): ${targetAvailabilityDate}`);

    // ==========================================
    // 3. API FETCHING
    // ==========================================
    log.info('API_STASIUN', `Menghubungi endpoint Master Stasiun: ${API_BASE_URL}/api/stasiun/public`);
    let stasiun = [];
    try {
      const stasiunRes = await axios.get(`${API_BASE_URL}/api/stasiun/public`, { timeout: 15000 });
      stasiun = stasiunRes.data;
      log.info('API_STASIUN', `Berhasil memuat ${stasiun.length} stasiun. Status: ${stasiunRes.status} ${stasiunRes.statusText}`);
      if (stasiun.length > 0) {
        log.debug('API_STASIUN', `Contoh stasiun pertama: ${stasiun[0].kode_stasiun} (${stasiun[0].provinsi})`);
      }
    } catch (err) {
      log.error('API_STASIUN', 'Gagal menarik data stasiun master! Skrip tidak dapat dilanjutkan.', err);
      throw err;
    }

    // Availability
    log.info('API_AVAIL', `Menghubungi endpoint Availability: ${API_BASE_URL}/api/availability/public/`);
    let availabilityData = {};
    try {
      const availRes = await axios.get(`${API_BASE_URL}/api/availability/public/`, { timeout: 20000 });
      if (availRes.status === 200) {
        availabilityData = availRes.data.data || {};
        const stationKeyCount = Object.keys(availabilityData).length;
        log.info('API_AVAIL', `Berhasil memuat Availability data untuk ${stationKeyCount} stasiun. Status: ${availRes.status}`);
      } else {
        log.warn('API_AVAIL', `Response status tidak 200. Menerima status: ${availRes.status}`);
      }
    } catch (err) {
      log.warn('API_AVAIL', `Gagal menarik data Availability (proses tetap dilanjutkan tanpa data Availability): ${err.message}`);
      if (err.isAxiosError) {
        log.debug('API_AVAIL', `Axios status: ${err.response?.status} | Response: ${JSON.stringify(err.response?.data || {})}`);
      }
    }

    // Parallel Daily QC Summaries
    log.info('API_QC', `Mempersiapkan paralel requests untuk ${datesToFetch.length} hari QC data...`);
    const qcData = {};
    let successCount = 0;
    let failureCount = 0;

    const qcRequests = datesToFetch.map(dateObj => {
      const targetUrl = `${API_BASE_URL}/api/qc/public/summary/${dateObj.apiDate}`;
      log.debug('API_QC_REQ', `Dispatching request: ${targetUrl}`);
      
      return axios.get(targetUrl, { timeout: 20000 })
        .then(res => {
          qcData[dateObj.label] = res.data;
          successCount++;
          log.info('API_QC_RES', `[OK] Tanggal ${dateObj.label} (${dateObj.apiDate}): Diterima ${res.data.length} records. Status: ${res.status}`);
        })
        .catch(err => {
          qcData[dateObj.label] = [];
          failureCount++;
          log.error('API_QC_RES', `[FAIL] Gagal mengambil tanggal ${dateObj.label} (${dateObj.apiDate})`, err);
        });
    });

    await Promise.all(qcRequests);
    log.info('API_QC', `Semua batch fetch QC selesai. Berhasil: ${successCount}/${datesToFetch.length} | Gagal: ${failureCount}/${datesToFetch.length}`);

    // ==========================================
    // 4. DATA PROCESSING & CLASSIFICATION
    // ==========================================
    log.info('PROCESS', `Memulai pemrosesan, pembobotan, dan klasifikasi ${stasiun.length} stasiun...`);
    const headerLeft = ["stasiun_id", "kode_stasiun", "provinsi", "upt_penanggung_jawab", "jaringan", "prioritas"];
    const headerDates = datesToFetch.map(d => d.label);
    const headerRight = [
      "result", "Availability", "Deskripsi Masalah",
      "Analisis Masalah", "Tindak Lanjut", "PIC", "Sistem Analisis",
      "Potensi Masalah", "Solusi Awal"
    ];
    const fullHeader = [...headerLeft, ...headerDates, ...headerRight];

    let rows = [];
    let stats = { "Baik": 0, "Cukup Baik": 0, "Buruk": 0, "Mati": 0 };
    let unmappedPICCount = 0;
    let missingAvailCount = 0;

    stasiun.forEach((s, idx) => {
      try {
        let row = [s.stasiun_id, s.kode_stasiun, s.provinsi, s.upt_penanggung_jawab, s.jaringan, s.prioritas];

        let totalWeightedScore = 0;
        let totalWeight = 0;
        let detailsqc = '';

        datesToFetch.forEach((d, dateIndex) => {
          const dailyQC = qcData[d.label] || [];
          const match = dailyQC.find(q => q.code === s.kode_stasiun);

          let dailyScore = (match && match.quality_percentage != null) ? Number(match.quality_percentage) : 0;
          row.push(dailyScore);

          let weight = dateIndex + 1; // 1 to 7
          let currentWeightedScore = dailyScore * weight;

          totalWeightedScore += currentWeightedScore;
          totalWeight += weight;

          if (DEBUG_STATION_CODE !== "" && s.kode_stasiun === DEBUG_STATION_CODE) {
            log.debug('DEBUG_STATION', `[${s.kode_stasiun}] Tgl: ${d.label} | Skor: ${dailyScore}% | Bobot: ${weight} | WxS: ${currentWeightedScore}`);
          }
          detailsqc = (match && match.details != null) ? match.details : '';
        });

        const averageScore = totalWeight > 0 ? (totalWeightedScore / totalWeight) : 0;
        let classification = "Mati";
        if (averageScore >= 90) classification = "Baik";
        else if (averageScore >= 60) classification = "Cukup Baik";
        else if (averageScore > 0) classification = "Buruk";
        else classification = "Mati";

        stats[classification]++;

        if (DEBUG_STATION_CODE !== "" && s.kode_stasiun === DEBUG_STATION_CODE) {
          log.debug('DEBUG_STATION', `[${s.kode_stasiun}] Total Skor Tertimbang: ${totalWeightedScore} | Total Bobot: ${totalWeight} | Skor Akhir: ${averageScore.toFixed(2)}% | Status: ${classification}`);
        }

        // Availability lookup
        let availabilityValue = "";
        if (availabilityData[s.kode_stasiun]) {
          const dayData = availabilityData[s.kode_stasiun].find(item => item.timestamp && item.timestamp.startsWith(targetAvailabilityDate));
          if (dayData && dayData.availability != null) {
            availabilityValue = dayData.availability;
          } else {
            missingAvailCount++;
          }
        } else {
          missingAvailCount++;
        }

        // Potential Issues & Initial Solutions
        let potensiArr = [];
        let solusiArr = [];
        let safeDetailsQc = detailsqc || "";

        if (classification === "Mati") {
          potensiArr.push("Masalah daya");
          solusiArr.push("Penggantian baterai,\nPenggantian panel surya,\nPenggantian solar controller");
        } else {
          if (safeDetailsQc.includes("Availability")) {
            potensiArr.push("Masalah daya");
            solusiArr.push("Penggantian baterai,\nPenggantian panel surya,\nPenggantian solar controller");
          }
          if (safeDetailsQc.includes("Noise tinggi")) {
            potensiArr.push("Masalah di lokasi (site)");
            solusiArr.push("-");
          }
          if (safeDetailsQc.includes("Cek metadata komponen")) {
            potensiArr.push("Ketidaksesuaian metadata dengan merek dan tipe sensor atau digitizer");
            solusiArr.push("Pengecekan merek dan tipe sensor serta digitizer untuk disesuaikan dengan metadata");
          }
          const isSensorIssue = /Terlalu banyak overlap|Terlalu banyak gap|Spike berlebihan|Komponen\s+.*?\s+(Mati|tidak merespon getaran|Rusak)/i.test(safeDetailsQc);
          if (isSensorIssue) {
            potensiArr.push("Masalah sensor");
            solusiArr.push("Penggantian sensor,\nPenggantian kabel konektor sensor ke digitizer");
          }
        }

        let potensiMasalah = potensiArr.join(",\n\n");
        let solusiAwal = solusiArr.join(",\n\n");
        let displayDetailsQc = safeDetailsQc.replace(/,\s*/g, ',\n');

        row.push(classification);
        row.push(availabilityValue);
        row.push(""); // Deskripsi Masalah
        row.push(""); // Analisis Masalah
        row.push(""); // Tindak Lanjut

        // PIC Matching
        let pic = "";
        for (const [name, provinces] of Object.entries(PIC_MAPPING)) {
          if (provinces.includes(s.provinsi)) {
            pic = name;
            break;
          }
        }
        if (!pic) unmappedPICCount++;

        row.push(pic);
        row.push(displayDetailsQc);
        row.push(potensiMasalah);
        row.push(solusiAwal);

        rows.push(row);

        // Progress logging
        if ((idx + 1) % 100 === 0 || idx === stasiun.length - 1) {
          log.info('PROCESS_PROGRESS', `Memproses stasiun: ${idx + 1}/${stasiun.length} (${Math.round(((idx + 1) / stasiun.length) * 100)}%)`);
        }
      } catch (rowErr) {
        log.error('PROCESS_ROW', `Error saat memproses stasiun index ${idx} [${s.kode_stasiun || 'UNKNOWN'}]: ${rowErr.message}`, rowErr);
      }
    });

    log.info('PROCESS_SUMMARY', `Hasil Klasifikasi: Baik=${stats["Baik"]}, Cukup Baik=${stats["Cukup Baik"]}, Buruk=${stats["Buruk"]}, Mati=${stats["Mati"]}`);
    if (unmappedPICCount > 0) {
      log.warn('PROCESS_SUMMARY', `Terdapat ${unmappedPICCount} stasiun yang provinsinya tidak cocok dengan PIC_MAPPING.`);
    }
    if (missingAvailCount > 0) {
      log.warn('PROCESS_SUMMARY', `Terdapat ${missingAvailCount} stasiun tanpa data Availability pada tanggal ${targetAvailabilityDate}.`);
    }

    // ==========================================
    // 5. GOOGLE SHEETS API PUSH
    // ==========================================
    if (rows.length === 0) {
      log.warn('SHEET_WRITE', 'Tidak ada data baris yang dihasilkan! Menolak menulis ke Google Sheets.');
      console.timeEnd("Total Execution Time");
      return;
    }

    log.info('SHEET_WRITE', `Membuat sheet baru "${sheetName}" pada tab index 1...`);
    const addSheetRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetName,
              index: 2
            }
          }
        }]
      }
    });

    const newSheetId = addSheetRes.data.replies[0].addSheet.properties.sheetId;
    log.info('SHEET_WRITE', `Berhasil membuat sheet "${sheetName}". Generated sheetId: ${newSheetId}`);

    const dataToPush = [fullHeader, ...rows];
    const writeRange = `'${sheetName}'!A1`;
    log.info('SHEET_WRITE', `Menulis ${dataToPush.length} baris x ${fullHeader.length} kolom ke range: ${writeRange}...`);

    const updateRes = await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: writeRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: dataToPush }
    });

    log.info('SHEET_WRITE', `[SUKSES] Berhasil mengupdate spreadsheet! Diperbarui: ${updateRes.data.updatedRows} baris, ${updateRes.data.updatedColumns} kolom, total ${updateRes.data.updatedCells} sel.`);

    log.info('FINISH', `Sheet "${sheetName}" berhasil dibuat dan diisi sepenuhnya.`);
  } catch (fatalErr) {
    log.error('FATAL', 'Terjadi kegagalan kritis yang menghentikan eksekusi skrip!', fatalErr);
  } finally {
    console.timeEnd("Total Execution Time");
    log.info('END', '================ EKSEKUSI SKRIP SELESAI ================');
  }
}

buatSheetHarian();