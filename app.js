/* ==========================================================================
   PersonalOS — Archivio Personale & SecureVault (Unified PWA Logic)
   100% Offline • AES-256-GCM + PBKDF2 (100.000 iter.) • Zero Cloud
   ========================================================================== */

const KEY_ARCHIVE_DB = 'archivio_personale_v3';
const KEY_VAULT_DB   = 'secure_vault_encrypted';

// Stato Archivio Personale (Faldoni, Inventario, Prestiti)
let state = loadAndMigrateArchiveState();

// Stato In-Memory di SecureVault (azzerato quando il Vault è bloccato)
let vaultData = [];
let encryptionKey = null;
let currentSalt = null;
let visiblePasswords = new Set();
let autoLockTimer = null;
let autoLockMinutes = 5;

/* ==========================================================================
   1. INIZIALIZZAZIONE & MIGRAZIONE AUTOMATICA DAI VECCHI DATABASE
   ========================================================================== */
function safeParseLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function loadAndMigrateArchiveState() {
  let current = safeParseLocal(KEY_ARCHIVE_DB) || safeParseLocal('personal_os_unified_archive_v1');

  if (!current) {
    const oldData = safeParseLocal('archivio_personale_unico_v1')
                 || safeParseLocal('archivio_personale_v1')
                 || safeParseLocal('archiviopersonal_os_v1')
                 || {};
    current = {
      boxes: Array.isArray(oldData.boxes) ? oldData.boxes : [],
      inventory: Array.isArray(oldData.inventory) ? oldData.inventory : [],
      loans: Array.isArray(oldData.loans) ? oldData.loans : []
    };
    try {
      localStorage.setItem(KEY_ARCHIVE_DB, JSON.stringify(current));
    } catch (_) {}
  }

  if (!Array.isArray(current.boxes)) current.boxes = [];
  if (!Array.isArray(current.inventory)) current.inventory = [];
  if (!Array.isArray(current.loans)) current.loans = [];
  // Rimuoviamo eventuale vecchia chiave warranties se presente
  delete current.warranties;

  return current;
}

function saveState(msg = '') {
  try {
    localStorage.setItem(KEY_ARCHIVE_DB, JSON.stringify(state));
    if (msg) showToast(msg);
  } catch (err) {
    alert('Spazio del browser quasi pieno: esporta un backup JSON dalla sezione Cerca & Backup.');
  }
  renderAll();
  updateStorageQuotaUI();
}

/* ==========================================================================
   2. UTILITY UI, TOAST, ESCAPE HTML & NAVIGAZIONE TAB
   ========================================================================== */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let toastTimeout = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2200);
}

function copyText(text, msg = 'Copiato negli appunti!') {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast(msg)).catch(() => fallbackCopy(text, msg));
  } else {
    fallbackCopy(text, msg);
  }
}

function fallbackCopy(text, msg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  showToast(msg);
}

function showTab(tab) {
  const tabs = ['dash', 'box', 'inv', 'loan', 'vault', 'src'];
  if (!tabs.includes(tab)) tab = 'dash';

  tabs.forEach((t) => {
    const sec = document.getElementById('sec-' + t);
    const btn = document.getElementById('t-' + t);
    if (sec) sec.hidden = (t !== tab);
    if (btn) btn.classList.toggle('active', t === tab);
  });

  if (tab === 'inv') populateBoxSelects();
  if (tab === 'dash') renderDashboard();
  if (tab === 'src') {
    updateStorageQuotaUI();
    runGlobalSearch();
  }
  if (tab === 'vault') {
    checkVaultLockUI();
  }
  resetAutoLockTimer();
}

/* ==========================================================================
   3. COMPRESSIONE FOTO OGGETTI INVENTARIO & VISUALIZZATORE
   ========================================================================== */
function compressPhoto(file) {
  return new Promise((resolve) => {
    if (!file || !file.type.startsWith('image/')) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const maxW = 750;
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

function openPhotoViewer(id) {
  const item = state.inventory.find((x) => String(x.id) === String(id));
  if (!item || !item.photo) return;
  document.getElementById('viewer-title').textContent = item.name || 'Foto Articolo';
  document.getElementById('viewer-body').innerHTML = `<img src="${item.photo}" alt="${escapeHtml(item.name)}" style="max-width:100%;max-height:70vh;border-radius:8px;object-fit:contain" />`;
  const dl = document.getElementById('viewer-download');
  dl.href = item.photo;
  dl.download = (item.name || 'articolo').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.jpg';
  document.getElementById('viewer-modal').hidden = false;
}

function closeViewer() {
  document.getElementById('viewer-modal').hidden = true;
  document.getElementById('viewer-body').innerHTML = '';
}

/* ==========================================================================
   4. MODULO FALDONI & UNITÀ D'ARCHIVIO (CRUD + STAMPA ETICHETTA)
   ========================================================================== */
function saveBox() {
  const editId = document.getElementById('box-edit-id').value;
  const code = document.getElementById('box-code').value.trim() || ('ARC-' + (state.boxes.length + 1));
  const name = document.getElementById('box-name').value.trim();
  const loc = document.getElementById('box-loc').value.trim();
  const tag = document.getElementById('box-tag').value.trim();
  const items = document.getElementById('box-items').value.trim();

  if (!name) return alert('Inserisci un nome per il contenitore o faldone.');

  if (editId) {
    const idx = state.boxes.findIndex((b) => String(b.id) === String(editId));
    if (idx >= 0) {
      state.boxes[idx] = { ...state.boxes[idx], code, name, loc, tag, items };
    }
    resetBoxForm();
    saveState('Unità aggiornata!');
  } else {
    state.boxes.unshift({
      id: Date.now(),
      code,
      name,
      loc,
      tag,
      items,
      createdAt: new Date().toLocaleDateString('it-IT')
    });
    resetBoxForm();
    saveState('Unità salvata!');
  }
}

function editBox(id) {
  const b = state.boxes.find((x) => String(x.id) === String(id));
  if (!b) return;
  document.getElementById('box-edit-id').value = String(b.id);
  document.getElementById('box-code').value = b.code || '';
  document.getElementById('box-name').value = b.name || '';
  document.getElementById('box-loc').value = b.loc || '';
  document.getElementById('box-tag').value = b.tag || '';
  document.getElementById('box-items').value = b.items || '';
  document.getElementById('box-form-title').textContent = '✏️ Modifica Unità: ' + b.code;
  document.getElementById('box-cancel-btn').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetBoxForm() {
  document.getElementById('box-edit-id').value = '';
  ['box-code', 'box-name', 'box-loc', 'box-tag', 'box-items'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  document.getElementById('box-form-title').textContent = "📦 Nuova Unità d'Archivio (Faldone, Scatola, Cartella, Cassetto)";
  document.getElementById('box-cancel-btn').hidden = true;
}

function deleteBox(id) {
  if (!confirm("Eliminare questa unità d'archivio?")) return;
  state.boxes = state.boxes.filter((b) => String(b.id) !== String(id));
  saveState('Unità eliminata.');
}

function printLabel(id) {
  const b = state.boxes.find((x) => String(x.id) === String(id));
  if (!b) return;
  const linked = state.inventory.filter((i) => String(i.boxId) === String(b.id));
  const linkedHtml = linked.length
    ? '<p><strong>Articoli collegati (' + linked.length + '):</strong><br>' +
      linked.map((x) => '• ' + escapeHtml(x.name) + ' (x' + (x.qty || 1) + ')').join('<br>') + '</p>'
    : '';

  const win = window.open('', '_blank');
  if (!win) return alert("Abilita i popup del browser per stampare l'etichetta.");
  win.document.write(
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Etichetta ' + escapeHtml(b.code) + '</title>' +
    '<style>body{font-family:sans-serif;padding:24px;color:#000}.lbl{border:4px solid #000;padding:20px;max-width:420px;border-radius:10px}h1{margin:0;font-size:38px;border-bottom:2px solid #000;padding-bottom:8px}</style>' +
    '</head><body onload="window.print()"><div class="lbl">' +
    '<h1>[' + escapeHtml(b.code) + ']</h1>' +
    '<h2>' + escapeHtml(b.name) + '</h2>' +
    '<p><strong>Posizione:</strong> ' + escapeHtml(b.loc || '-') + '</p>' +
    '<p><strong>Note Contenuto:</strong><br>' + escapeHtml(b.items || '-').replace(/\n/g, '<br>') + '</p>' +
    linkedHtml +
    '<small>Archivio Personale — ' + escapeHtml(b.createdAt || '-') + '</small>' +
    '</div></body></html>'
  );
  win.document.close();
}

/* ==========================================================================
   5. MODULO INVENTARIO OGGETTI & DOCUMENTI (CRUD + FOTO)
   ========================================================================== */
function populateBoxSelects() {
  const optionsHtml = state.boxes
    .map((b) => `<option value="${b.id}">[${escapeHtml(b.code)}] ${escapeHtml(b.name)} (${escapeHtml(b.loc || '-')})</option>`)
    .join('');

  const invBox = document.getElementById('inv-box');
  if (invBox) {
    const cur = invBox.value;
    invBox.innerHTML = '<option value="">-- Nessun faldone specifico / Posizione libera --</option>' + optionsHtml;
    invBox.value = cur;
  }

  const invFilterBox = document.getElementById('inv-filter-box');
  if (invFilterBox) {
    const curF = invFilterBox.value;
    invFilterBox.innerHTML = '<option value="">Tutti i Faldoni / Posizioni</option><option value="__FREE__">Solo Posizione Libera</option>' + optionsHtml;
    invFilterBox.value = curF;
  }

  const datalist = document.getElementById('inventory-suggestions');
  if (datalist) {
    datalist.innerHTML = state.inventory
      .map((i) => `<option value="${escapeHtml(i.name)}"></option>`)
      .join('');
  }
}

async function saveInventoryItem() {
  const editId = document.getElementById('inv-edit-id').value;
  const name = document.getElementById('inv-name').value.trim();
  if (!name) return alert("Inserisci il nome dell'oggetto o documento.");

  const boxId = document.getElementById('inv-box').value;
  const cat = document.getElementById('inv-cat').value.trim() || 'Generale';
  const qty = Math.max(1, parseInt(document.getElementById('inv-qty').value || '1', 10));
  const cond = document.getElementById('inv-cond').value;
  const val = parseFloat(document.getElementById('inv-val').value || '0') || 0;
  const notes = document.getElementById('inv-notes').value.trim();
  const photoFile = document.getElementById('inv-photo').files[0];
  const newPhoto = await compressPhoto(photoFile);

  if (editId) {
    const idx = state.inventory.findIndex((x) => String(x.id) === String(editId));
    if (idx >= 0) {
      state.inventory[idx] = {
        ...state.inventory[idx],
        name,
        boxId,
        cat,
        qty,
        cond,
        val,
        notes,
        photo: newPhoto || state.inventory[idx].photo || null
      };
    }
    resetInvForm();
    saveState('Articolo aggiornato!');
  } else {
    state.inventory.unshift({
      id: Date.now(),
      name,
      boxId,
      cat,
      qty,
      cond,
      val,
      notes,
      photo: newPhoto,
      addedAt: new Date().toLocaleDateString('it-IT')
    });
    resetInvForm();
    saveState("Aggiunto all'inventario!");
  }
}

function editInventoryItem(id) {
  const item = state.inventory.find((x) => String(x.id) === String(id));
  if (!item) return;
  populateBoxSelects();
  document.getElementById('inv-edit-id').value = String(item.id);
  document.getElementById('inv-name').value = item.name || '';
  document.getElementById('inv-box').value = item.boxId || '';
  document.getElementById('inv-cat').value = item.cat || '';
  document.getElementById('inv-qty').value = item.qty || 1;
  document.getElementById('inv-cond').value = item.cond || 'Ottimo / Nuovo';
  document.getElementById('inv-val').value = item.val || '';
  document.getElementById('inv-notes').value = item.notes || '';
  document.getElementById('inv-form-title').textContent = '✏️ Modifica Articolo: ' + item.name;
  document.getElementById('inv-cancel-btn').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetInvForm() {
  document.getElementById('inv-edit-id').value = '';
  ['inv-name', 'inv-cat', 'inv-val', 'inv-notes', 'inv-photo'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  document.getElementById('inv-qty').value = '1';
  document.getElementById('inv-box').value = '';
  document.getElementById('inv-form-title').textContent = "📋 Aggiungi Articolo o Documento all'Inventario";
  document.getElementById('inv-cancel-btn').hidden = true;
}

function deleteInventoryItem(id) {
  if (!confirm("Rimuovere questo articolo dall'inventario?")) return;
  state.inventory = state.inventory.filter((x) => String(x.id) !== String(id));
  saveState('Articolo rimosso.');
}

/* ==========================================================================
   6. MODULO REGISTRO PRESTITI
   ========================================================================== */
function saveLoan() {
  const editId = document.getElementById('ln-edit-id').value;
  const item = document.getElementById('ln-item').value.trim();
  const person = document.getElementById('ln-person').value.trim();
  const dateStr = document.getElementById('ln-date').value;
  const dueStr = document.getElementById('ln-due').value;
  const notes = document.getElementById('ln-notes').value.trim();

  if (!item || !person) return alert('Inserisci cosa hai prestato e a chi.');

  if (editId) {
    const idx = state.loans.findIndex((l) => String(l.id) === String(editId));
    if (idx >= 0) {
      state.loans[idx] = { ...state.loans[idx], item, person, dateStr, dueStr, notes };
    }
    resetLoanForm();
    saveState('Prestito aggiornato!');
  } else {
    state.loans.unshift({
      id: Date.now(),
      item,
      person,
      dateStr,
      dueStr,
      notes,
      returned: false,
      returnedAt: null
    });
    resetLoanForm();
    saveState('Prestito registrato!');
  }
}

function editLoan(id) {
  const l = state.loans.find((x) => String(x.id) === String(id));
  if (!l) return;
  document.getElementById('ln-edit-id').value = String(l.id);
  document.getElementById('ln-item').value = l.item || '';
  document.getElementById('ln-person').value = l.person || '';
  document.getElementById('ln-date').value = l.dateStr || '';
  document.getElementById('ln-due').value = l.dueStr || '';
  document.getElementById('ln-notes').value = l.notes || '';
  document.getElementById('loan-form-title').textContent = '✏️ Modifica Prestito: ' + l.item;
  document.getElementById('loan-cancel-btn').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetLoanForm() {
  document.getElementById('ln-edit-id').value = '';
  ['ln-item', 'ln-person', 'ln-due', 'ln-notes'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  document.getElementById('ln-date').valueAsDate = new Date();
  document.getElementById('loan-form-title').textContent = "🤝 Registra un Nuovo Prestito (Uscita dall'Archivio)";
  document.getElementById('loan-cancel-btn').hidden = true;
}

function toggleLoanReturned(id) {
  const ln = state.loans.find((x) => String(x.id) === String(id));
  if (!ln) return;
  ln.returned = !ln.returned;
  ln.returnedAt = ln.returned ? new Date().toLocaleDateString('it-IT') : null;
  saveState(ln.returned ? 'Segnato come restituito!' : 'Prestito riaperto.');
}

function deleteLoan(id) {
  if (!confirm('Eliminare questa voce dal registro prestiti?')) return;
  state.loans = state.loans.filter((x) => String(x.id) !== String(id));
  saveState('Voce eliminata.');
}

/* ==========================================================================
   7. RENDER GLOBALE ARCHIVIO & DASHBOARD
   ========================================================================== */
function getBoxLabel(boxId) {
  if (!boxId) return 'Posizione libera';
  const b = state.boxes.find((x) => String(x.id) === String(boxId));
  return b ? `[${b.code}] ${b.name}${b.loc ? ' (' + b.loc + ')' : ''}` : 'Posizione libera';
}

function renderDashboard() {
  const today = new Date().toISOString().slice(0, 10);

  document.getElementById('stat-boxes').textContent = state.boxes.length;
  const totalItems = state.inventory.reduce((acc, x) => acc + (Number(x.qty) || 1), 0);
  const totalVal = state.inventory.reduce((acc, x) => acc + ((Number(x.val) || 0) * (Number(x.qty) || 1)), 0);
  const activeLoans = state.loans.filter((l) => !l.returned);

  document.getElementById('stat-items').textContent = totalItems;
  document.getElementById('stat-value').textContent = totalVal.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
  document.getElementById('stat-loans').textContent = activeLoans.length;

  const statVault = document.getElementById('stat-vault');
  if (encryptionKey) {
    statVault.textContent = vaultData.length + ' 🔓';
  } else {
    const storedVault = getStoredVault();
    statVault.textContent = storedVault ? '🔒 Cifrato' : '➕ Crea';
  }

  // Prestiti attivi su Dashboard
  const dashLoans = document.getElementById('dash-loans');
  if (activeLoans.length === 0) {
    dashLoans.innerHTML = '<p style="color:var(--muted);font-size:0.86rem">Nessun oggetto o documento attualmente fuori in prestito.</p>';
  } else {
    dashLoans.innerHTML = activeLoans.map((l) => {
      const overdue = l.dueStr && l.dueStr < today;
      return `
        <div class="item-card">
          <div>
            <span class="tag ${overdue ? 'red' : 'amber'}">
              ${overdue ? '⚠️ IN RITARDO (Scad. ' + escapeHtml(l.dueStr) + ')' : 'IN PRESTITO a ' + escapeHtml(l.person)}
            </span>
            <h4 style="margin:6px 0">${escapeHtml(l.item)}</h4>
            <small style="color:var(--muted)">Uscito il: ${escapeHtml(l.dateStr || '-')} ${l.notes ? '• ' + escapeHtml(l.notes) : ''}</small>
          </div>
          <button class="btn success small" onclick="toggleLoanReturned(${l.id})">✅ Segna Restituito</button>
        </div>`;
    }).join('');
  }

  // Ultimi Articoli in Inventario su Dashboard
  const dashInv = document.getElementById('dash-recent-inv');
  if ( dashInv ) {
    if (state.inventory.length === 0) {
      dashInv.innerHTML = '<p style="color:var(--muted);font-size:0.86rem">Nessun articolo ancora presente in inventario.</p>';
    } else {
      dashInv.innerHTML = state.inventory.slice(0, 5).map((item) => `
        <div class="item-card" onclick="showTab('inv')" style="cursor:pointer">
          <div>
            <span class="tag blue">📦 ${escapeHtml(getBoxLabel(item.boxId))}</span>
            <span class="tag">Qtà: ${escapeHtml(item.qty)}</span>
            <h4 style="margin:6px 0">${escapeHtml(item.name)}</h4>
            <small style="color:var(--muted)">${escapeHtml(item.cat || 'Generale')}</small>
          </div>
        </div>`).join('');
    }
  }
}

function renderAll() {
  populateBoxSelects();
  renderDashboard();

  const today = new Date().toISOString().slice(0, 10);

  // 1. Render Faldoni
  const boxQuery = (document.getElementById('box-filter')?.value || '').toLowerCase().trim();
  const filteredBoxes = state.boxes.filter((b) =>
    !boxQuery || [b.code, b.name, b.loc, b.tag, b.items].join(' ').toLowerCase().includes(boxQuery)
  );

  document.getElementById('box-list').innerHTML = filteredBoxes.length === 0
    ? '<p style="color:var(--muted)">Nessuna unità registrata.</p>'
    : filteredBoxes.map((b) => {
        const countInBox = state.inventory.filter((i) => String(i.boxId) === String(b.id)).length;
        return `
          <div class="item-card">
            <div style="flex:1;min-width:220px">
              <span class="tag blue">[${escapeHtml(b.code)}]</span>
              <span class="tag">📍 ${escapeHtml(b.loc || 'Posizione N/D')}</span>
              ${b.tag ? `<span class="tag">🏷️ ${escapeHtml(b.tag)}</span>` : ''}
              <span class="tag emerald">${countInBox} articoli collegati</span>
              <h3 style="margin:6px 0">${escapeHtml(b.name)}</h3>
              ${b.items ? `<p style="margin:4px 0;color:var(--text-secondary);white-space:pre-line;font-size:0.88rem">${escapeHtml(b.items)}</p>` : ''}
            </div>
            <div class="btn-group">
              <button class="btn secondary small" onclick="printLabel(${b.id})">🖨️ Etichetta</button>
              <button class="btn secondary small" onclick="editBox(${b.id})">✏️</button>
              <button class="btn danger small" onclick="deleteBox(${b.id})">🗑️</button>
            </div>
          </div>`;
      }).join('');

  // 2. Render Inventario
  const invQuery = (document.getElementById('inv-filter')?.value || '').toLowerCase().trim();
  const invBoxFilter = document.getElementById('inv-filter-box')?.value || '';
  const filteredInv = state.inventory.filter((item) => {
    const matchText = !invQuery || [item.name, item.cat, item.notes, getBoxLabel(item.boxId)].join(' ').toLowerCase().includes(invQuery);
    const matchBox = !invBoxFilter
      || (invBoxFilter === '__FREE__' && !item.boxId)
      || String(item.boxId) === String(invBoxFilter);
    return matchText && matchBox;
  });

  document.getElementById('inv-list').innerHTML = filteredInv.length === 0
    ? '<p style="color:var(--muted)">Nessun articolo in inventario.</p>'
    : filteredInv.map((item) => `
        <div class="item-card">
          <div style="flex:1;min-width:220px">
            <span class="tag blue">📦 ${escapeHtml(getBoxLabel(item.boxId))}</span>
            <span class="tag">Qtà: ${escapeHtml(item.qty)}</span>
            <span class="tag">${escapeHtml(item.cond)}</span>
            ${item.val ? `<span class="tag emerald">${Number(item.val).toLocaleString('it-IT')} €</span>` : ''}
            <h3 style="margin:6px 0">${escapeHtml(item.name)}</h3>
            <small style="color:var(--muted)">Categoria: <strong>${escapeHtml(item.cat)}</strong> ${item.notes ? '• Note: ' + escapeHtml(item.notes) : ''}</small>
          </div>
          <div class="btn-group">
            ${item.photo ? `<button class="btn small" onclick="openPhotoViewer(${item.id})">🖼️ Foto</button>` : ''}
            <button class="btn secondary small" onclick="editInventoryItem(${item.id})">✏️</button>
            <button class="btn danger small" onclick="deleteInventoryItem(${item.id})">🗑️</button>
          </div>
        </div>`).join('');

  // 3. Render Prestiti
  document.getElementById('loan-list').innerHTML = state.loans.length === 0
    ? '<p style="color:var(--muted)">Nessun prestito registrato.</p>'
    : state.loans.map((l) => {
        const overdue = !l.returned && l.dueStr && l.dueStr < today;
        const cls = l.returned ? 'emerald' : (overdue ? 'red' : 'amber');
        const txt = l.returned
          ? 'RESTITUITO il ' + (l.returnedAt || '-')
          : (overdue ? 'IN RITARDO (Entro ' + l.dueStr + ')' : 'IN PRESTITO');
        return `
          <div class="item-card">
            <div style="flex:1;min-width:220px">
              <span class="tag ${cls}">${escapeHtml(txt)}</span>
              <h3 style="margin:6px 0">${escapeHtml(l.item)} → 👤 ${escapeHtml(l.person)}</h3>
              <small style="color:var(--muted)">Consegnato il: ${escapeHtml(l.dateStr || '-')} ${l.dueStr ? '• Rientro previsto: ' + escapeHtml(l.dueStr) : ''} ${l.notes ? '• ' + escapeHtml(l.notes) : ''}</small>
            </div>
            <div class="btn-group">
              <button class="btn ${l.returned ? 'secondary' : 'success'} small" onclick="toggleLoanReturned(${l.id})">
                ${l.returned ? '↩️ Riapri' : '✅ Restituito'}
              </button>
              <button class="btn secondary small" onclick="editLoan(${l.id})">✏️</button>
              <button class="btn danger small" onclick="deleteLoan(${l.id})">🗑️</button>
            </div>
          </div>`;
      }).join('');
}

/* ==========================================================================
   8. SECUREVAULT — CRITTOGRAFIA WEB CRYPTO API (PBKDF2 + AES-256-GCM)
   ========================================================================== */
function getStoredVault() {
  return safeParseLocal(KEY_VAULT_DB);
}

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function saveVault() {
  if (!encryptionKey) return;
  if (!currentSalt) {
    currentSalt = window.crypto.getRandomValues(new Uint8Array(16));
  }
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(vaultData));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    encryptionKey,
    encoded
  );
  const record = {
    salt: Array.from(currentSalt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(encrypted))
  };
  localStorage.setItem(KEY_VAULT_DB, JSON.stringify(record));
  updateStorageQuotaUI();
  renderDashboard();
}

async function decryptVaultData(ciphertext, iv) {
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    encryptionKey,
    new Uint8Array(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}

function checkVaultLockUI() {
  const stored = getStoredVault();
  const isUnlocked = Boolean(encryptionKey);

  document.getElementById('vault-lock-screen').hidden = isUnlocked;
  document.getElementById('vault-dashboard').hidden = !isUnlocked;

  const badge = document.getElementById('vault-status-badge');
  const quickLock = document.getElementById('btn-quick-lock');

  if (isUnlocked) {
    badge.textContent = `🔓 Vault Sbloccato (${vaultData.length})`;
    badge.className = 'badge unlocked';
    quickLock.hidden = false;
    renderVaultPasswords();
  } else {
    badge.textContent = '🔒 Vault Bloccato';
    badge.className = 'badge locked';
    quickLock.hidden = true;

    const confirmWrap = document.getElementById('master-confirm-wrap');
    const confirmInput = document.getElementById('master-confirm-input');
    if (!stored) {
      document.getElementById('lock-title').textContent = 'Crea Master Password';
      document.getElementById('lock-desc').textContent = 'Imposta una password sicura per crittografare il tuo nuovo database offline.';
      document.getElementById('master-btn').textContent = '🛡️ Crea Vault';
      document.getElementById('reset-box').hidden = true;
      confirmWrap.hidden = false;
      confirmInput.required = true;
    } else {
      document.getElementById('lock-title').textContent = 'Sblocca Vault';
      document.getElementById('lock-desc').textContent = 'Inserisci la Master Password per accedere ai dati salvati in locale.';
      document.getElementById('master-btn').textContent = '🔓 Accedi';
      document.getElementById('reset-box').hidden = false;
      confirmWrap.hidden = true;
      confirmInput.required = false;
    }
  }
}

async function handleMasterSubmit(e) {
  e.preventDefault();
  const password = document.getElementById('master-input').value;
  const stored = getStoredVault();

  if (!stored) {
    const confirmPass = document.getElementById('master-confirm-input').value;
    if (password.length < 4) return alert('La Master Password deve contenere almeno 4 caratteri.');
    if (password !== confirmPass) return alert('Le due Master Password non coincidono.');

    currentSalt = window.crypto.getRandomValues(new Uint8Array(16));
    encryptionKey = await deriveKey(password, currentSalt);
    vaultData = [];
    await saveVault();
    document.getElementById('master-input').value = '';
    document.getElementById('master-confirm-input').value = '';
    checkVaultLockUI();
    resetAutoLockTimer();
    showToast('Cassaforte SecureVault creata!');
  } else {
    try {
      currentSalt = new Uint8Array(stored.salt);
      encryptionKey = await deriveKey(password, currentSalt);
      const decrypted = await decryptVaultData(stored.ciphertext, stored.iv);
      vaultData = JSON.parse(decrypted);
      if (!Array.isArray(vaultData)) vaultData = [];
      document.getElementById('master-input').value = '';
      checkVaultLockUI();
      resetAutoLockTimer();
      renderDashboard();
      showToast('Vault sbloccato!');
    } catch (err) {
      encryptionKey = null;
      currentSalt = null;
      alert('Master Password errata.');
      document.getElementById('reset-box').hidden = false;
    }
  }
}

function lockVault(reason = '') {
  encryptionKey = null;
  currentSalt = null;
  vaultData = [];
  visiblePasswords.clear();
  if (autoLockTimer) clearTimeout(autoLockTimer);
  closeCredentialModal();
  checkVaultLockUI();
  renderDashboard();
  if (reason) showToast(reason);
}

function updateAutoLockMinutes() {
  const sel = document.getElementById('vault-autolock-select');
  autoLockMinutes = parseInt(sel.value, 10) || 0;
  resetAutoLockTimer();
  showToast(autoLockMinutes > 0 ? `Auto-Lock impostato a ${autoLockMinutes} min` : 'Auto-Lock disattivato');
}

function resetAutoLockTimer() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  if (!encryptionKey || autoLockMinutes <= 0) return;
  autoLockTimer = setTimeout(() => {
    if (encryptionKey) {
      lockVault('🔒 Vault bloccato per inattività');
    }
  }, autoLockMinutes * 60 * 1000);
}

['click', 'keydown', 'mousemove', 'touchstart'].forEach((ev) => {
  window.addEventListener(ev, () => {
    if (encryptionKey) resetAutoLockTimer();
  }, { passive: true });
});

function resetCorruptedVault() {
  if (confirm('Vuoi azzerare il Vault per impostare una nuova Master Password?')) {
    localStorage.removeItem(KEY_VAULT_DB);
    lockVault('Vault azzerato.');
  }
}

async function changeMasterPassword() {
  if (!encryptionKey) return;
  const newPass = prompt('Inserisci la nuova Master Password (minimo 4 caratteri):');
  if (!newPass || newPass.trim().length < 4) return;
  currentSalt = window.crypto.getRandomValues(new Uint8Array(16));
  encryptionKey = await deriveKey(newPass, currentSalt);
  await saveVault();
  alert('Master Password aggiornata!');
}

async function clearAllPasswords() {
  if (!encryptionKey) return;
  if (confirm("Vuoi svuotare tutta la lista delle password salvate? (Utile per eliminare l'importazione errata precedente e ricaricare il CSV di Google da zero)")) {
    vaultData = [];
    visiblePasswords.clear();
    await saveVault();
    renderVaultPasswords();
    showToast('Lista svuotata!');
  }
}

/* ==========================================================================
   9. GESTIONE CREDENZIALI, GENERATORE & AUDIT DI SICUREZZA
   ========================================================================== */
function evaluatePasswordStrength(pass) {
  if (!pass) return { score: 0, label: 'Vuota', color: '#64748b' };
  let score = 0;
  if (pass.length >= 8) score += 25;
  if (pass.length >= 12) score += 25;
  if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) score += 20;
  if (/[0-9]/.test(pass)) score += 15;
  if (/[^A-Za-z0-9]/.test(pass)) score += 15;
  if (score < 45) return { score, label: 'Debole ⚠️', color: '#ef4444' };
  if (score < 75) return { score, label: 'Media', color: '#f59e0b' };
  return { score: Math.min(100, score), label: 'Forte 🛡️', color: '#10b981' };
}

function updateModalPassStrength() {
  const pass = document.getElementById('cred-pass').value;
  const st = evaluatePasswordStrength(pass);
  document.getElementById('pass-strength-label').textContent = 'Robustezza: ' + st.label;
  const bar = document.getElementById('pass-strength-bar');
  bar.style.width = st.score + '%';
  bar.style.background = st.color;
}

function generateRandomPassword() {
  const lenInput = document.getElementById('gen-len');
  const symCheck = document.getElementById('gen-sym');
  const length = Math.min(64, Math.max(8, parseInt(lenInput?.value || '16', 10)));
  const useSymbols = symCheck ? symCheck.checked : true;

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' + (useSymbols ? '@#$%&*!' : '');
  const randomValid = new Uint32Array(length);
  window.crypto.getRandomValues(randomValid);

  let pass = '';
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(randomValid[i] % chars.length);
  }
  document.getElementById('cred-pass').value = pass;
  updateModalPassStrength();
}

function openCredentialModal(editIndex = -1) {
  const modal = document.getElementById('credential-modal');
  document.getElementById('cred-edit-index').value = String(editIndex);

  if (editIndex >= 0 && vaultData[editIndex]) {
    const item = vaultData[editIndex];
    document.getElementById('modal-title').textContent = 'Dettagli & Modifica Credenziale';
    document.getElementById('cred-title').value = item.title || '';
    document.getElementById('cred-category').value = item.category || 'Altro';
    document.getElementById('cred-user').value = item.username || '';
    document.getElementById('cred-pass').value = item.password || '';
    document.getElementById('cred-url').value = item.url || '';
    document.getElementById('cred-note').value = item.note || '';
  } else {
    document.getElementById('modal-title').textContent = 'Nuova Credenziale';
    document.getElementById('cred-title').value = '';
    document.getElementById('cred-category').value = 'Social & Email';
    document.getElementById('cred-user').value = '';
    document.getElementById('cred-pass').value = '';
    document.getElementById('cred-url').value = '';
    document.getElementById('cred-note').value = '';
  }
  updateModalPassStrength();
  modal.hidden = false;
}

function closeCredentialModal() {
  document.getElementById('credential-modal').hidden = true;
}

function openCredUrl() {
  let u = document.getElementById('cred-url').value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  window.open(u, '_blank', 'noopener,noreferrer');
}

async function saveCredential(e) {
  e.preventDefault();
  if (!encryptionKey) return;
  const editIndex = parseInt(document.getElementById('cred-edit-index').value, 10);
  const title = document.getElementById('cred-title').value.trim();
  const category = document.getElementById('cred-category').value;
  const username = document.getElementById('cred-user').value.trim();
  const password = document.getElementById('cred-pass').value;
  const url = document.getElementById('cred-url').value.trim();
  const note = document.getElementById('cred-note').value.trim();

  const record = { title, category, username, password, url, note };

  if (editIndex >= 0 && editIndex < vaultData.length) {
    vaultData[editIndex] = record;
  } else {
    vaultData.push(record);
  }

  await saveVault();
  closeCredentialModal();
  renderVaultPasswords();
  showToast('Credenziale salvata!');
}

async function deleteCredential(e, realIndex) {
  if (e) e.stopPropagation();
  if (confirm('Vuoi eliminare questa credenziale?')) {
    vaultData.splice(realIndex, 1);
    visiblePasswords.delete(realIndex);
    await saveVault();
    renderVaultPasswords();
  }
}

function toggleShowPass(e, realIndex) {
  e.stopPropagation();
  if (visiblePasswords.has(realIndex)) {
    visiblePasswords.delete(realIndex);
  } else {
    visiblePasswords.add(realIndex);
  }
  renderVaultPasswords();
}

function copyPassByIndex(e, realIndex) {
  e.stopPropagation();
  const item = vaultData[realIndex];
  if (item) copyText(item.password, 'Password copiata!');
}

function copyUserByIndex(e, realIndex) {
  e.stopPropagation();
  const item = vaultData[realIndex];
  if (item) copyText(item.username, 'Username copiato!');
}

function renderVaultPasswords() {
  const listContainer = document.getElementById('passwords-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  const q = (document.getElementById('vault-search')?.value || '').toLowerCase().trim();
  const catF = document.getElementById('vault-cat-filter')?.value || '';

  const passCounts = {};
  let weakCount = 0;
  vaultData.forEach((item) => {
    const p = item.password || '';
    if (p) passCounts[p] = (passCounts[p] || 0) + 1;
    if (evaluatePasswordStrength(p).score < 45) weakCount++;
  });
  const reusedCount = Object.values(passCounts).filter((c) => c > 1).length;

  const auditBadge = document.getElementById('vault-audit-badge');
  if (weakCount === 0 && reusedCount === 0) {
    auditBadge.className = 'tag emerald';
    auditBadge.textContent = '🛡️ Audit: OK';
  } else {
    auditBadge.className = 'tag amber';
    auditBadge.textContent = `⚠️ ${weakCount} deboli • ${reusedCount} riutilizzate`;
  }

  document.getElementById('vault-counter-badge').textContent = `${vaultData.length} elementi`;

  const indexedItems = vaultData
    .map((item, realIndex) => ({ item, realIndex }))
    .filter(({ item }) => {
      const matchQ = !q
        || (item.title || '').toLowerCase().includes(q)
        || (item.username || '').toLowerCase().includes(q)
        || (item.url || '').toLowerCase().includes(q)
        || (item.note || '').toLowerCase().includes(q);
      const matchCat = !catF || (item.category || 'Altro') === catF;
      return matchQ && matchCat;
    });

  if (indexedItems.length === 0) {
    listContainer.innerHTML = '<div style="padding:28px;text-align:center;color:var(--muted);font-size:0.88rem">Nessuna credenziale trovata.</div>';
    return;
  }

  indexedItems.forEach(({ item, realIndex }) => {
    const isShown = visiblePasswords.has(realIndex);
    const st = evaluatePasswordStrength(item.password);
    const isReused = item.password && passCounts[item.password] > 1;

    const div = document.createElement('div');
    div.className = 'item-card vault-card';
    div.style.cursor = 'pointer';
    div.onclick = () => openCredentialModal(realIndex);

    div.innerHTML = `
      <div style="flex:1;min-width:220px">
        <div>
          ${item.category ? `<span class="tag emerald">${escapeHtml(item.category)}</span>` : ''}
          ${st.score < 45 ? '<span class="tag red">Debole</span>' : ''}
          ${isReused ? '<span class="tag amber">Riutilizzata</span>' : ''}
          ${item.url ? `<span class="tag">${escapeHtml(item.url)}</span>` : ''}
        </div>
        <h3 style="margin:6px 0">${escapeHtml(item.title || 'Senza nome')}</h3>
        <div class="mono" style="font-size:0.83rem;color:var(--text-secondary)">
          👤 ${escapeHtml(item.username || 'Nessun username')}
        </div>
        <div class="mono" style="font-size:0.84rem;margin-top:4px;color:${isShown ? '#34d399' : 'var(--muted)'}">
          🔑 ${isShown ? escapeHtml(item.password) : '••••••••••••'}
        </div>
        ${item.note ? `<small style="color:var(--muted);display:block;margin-top:4px">📝 ${escapeHtml(item.note)}</small>` : ''}
      </div>
      <div class="btn-group" onclick="event.stopPropagation()">
        <button class="btn secondary small" onclick="toggleShowPass(event, ${realIndex})" title="Mostra/Nascondi Password">
          ${isShown ? '🙈' : '👁️'}
        </button>
        <button class="btn secondary small" onclick="copyUserByIndex(event, ${realIndex})" title="Copia Username">
          👤 Copia ID
        </button>
        <button class="btn vault-btn small" onclick="copyPassByIndex(event, ${realIndex})" title="Copia Password">
          📋 Pass
        </button>
        <button class="btn danger small" onclick="deleteCredential(event, ${realIndex})" title="Elimina">
          🗑️
        </button>
      </div>
    `;
    listContainer.appendChild(div);
  });
}

/* ==========================================================================
   10. IMPORT / EXPORT CSV GOOGLE PASSWORD MANAGER (RFC-4180)
   ========================================================================== */
function exportVaultCSV() {
  if (!encryptionKey) return;
  let csv = 'name,url,username,password,note\n';
  vaultData.forEach((item) => {
    const t = (item.title || '').replace(/"/g, '""');
    const l = (item.url || '').replace(/"/g, '""');
    const u = (item.username || '').replace(/"/g, '""');
    const p = (item.password || '').replace(/"/g, '""');
    const n = (item.note || '').replace(/"/g, '""');
    csv += `"${t}","${l}","${u}","${p}","${n}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'securevault_passwords.csv';
  a.click();
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  result.push(cur.trim());
  return result;
}

function importVaultCSV(e) {
  if (!encryptionKey) return alert('Sblocca prima il Vault!');
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function (event) {
    const text = event.target.result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      alert('Il file CSV sembra vuoto.');
      return;
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
    let idxTitle = headers.findIndex((h) => h.includes('name') || h.includes('titolo') || h.includes('title'));
    let idxUrl = headers.findIndex((h) => h.includes('url') || h.includes('sito') || h.includes('website'));
    let idxUser = headers.findIndex((h) => h.includes('user') || h.includes('login') || h.includes('email'));
    let idxPass = headers.findIndex((h) => h.includes('pass'));
    let idxNote = headers.findIndex((h) => h.includes('note'));

    if (idxPass === -1) {
      idxTitle = 0; idxUrl = 1; idxUser = 2; idxPass = 3; idxNote = 4;
    }

    let addedCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) continue;

      const urlVal = idxUrl >= 0 ? (cols[idxUrl] || '') : '';
      let titleVal = idxTitle >= 0 ? (cols[idxTitle] || '') : '';
      if (!titleVal && urlVal) {
        try { titleVal = new URL(urlVal).hostname.replace('www.', ''); } catch (_) { titleVal = urlVal; }
      }
      const userVal = idxUser >= 0 ? (cols[idxUser] || '') : '';
      const passVal = idxPass >= 0 ? (cols[idxPass] || '') : '';
      const noteVal = idxNote >= 0 ? (cols[idxNote] || '') : '';

      if (titleVal || userVal || passVal) {
        vaultData.push({
          title: titleVal || 'Account',
          username: userVal,
          password: passVal,
          url: urlVal,
          note: noteVal,
          category: 'Altro'
        });
        addedCount++;
      }
    }

    e.target.value = '';
    if (addedCount > 0) {
      await saveVault();
      renderVaultPasswords();
      alert(`✅ Importate con successo ${addedCount} password da Google CSV!`);
    } else {
      alert('Nessuna password trovata nel file CSV.');
    }
  };
  reader.readAsText(file);
}

/* ==========================================================================
   11. RICERCA GLOBALE & BACKUP TOTALE UNIFICATO
   ========================================================================== */
function runGlobalSearch() {
  const q = (document.getElementById('q-search')?.value || '').toLowerCase().trim();
  const out = document.getElementById('search-results');
  if (!out) return;
  if (!q) {
    out.innerHTML = '';
    return;
  }

  const bM = state.boxes.filter((b) => [b.code, b.name, b.loc, b.tag, b.items].join(' ').toLowerCase().includes(q));
  const iM = state.inventory.filter((i) => [i.name, i.cat, i.notes, getBoxLabel(i.boxId)].join(' ').toLowerCase().includes(q));
  const lM = state.loans.filter((l) => [l.item, l.person, l.notes].join(' ').toLowerCase().includes(q));
  const vM = encryptionKey
    ? vaultData.filter((v) => [v.title, v.username, v.url, v.note].join(' ').toLowerCase().includes(q))
    : [];

  const cards = [
    ...bM.map((b) => `
      <div class="item-card" onclick="showTab('box')" style="cursor:pointer">
        <div>
          <strong>📦 Faldone [${escapeHtml(b.code)}] ${escapeHtml(b.name)}</strong> (${escapeHtml(b.loc || '-')})
          <br><small style="color:var(--muted)">${escapeHtml(b.items || '')}</small>
        </div>
      </div>`),
    ...iM.map((i) => `
      <div class="item-card" onclick="showTab('inv')" style="cursor:pointer">
        <div>
          <strong>📋 Oggetto: ${escapeHtml(i.name)}</strong> (Qtà: ${escapeHtml(i.qty)})
          <br><small style="color:var(--muted)">Si trova in: <strong>${escapeHtml(getBoxLabel(i.boxId))}</strong> • ${escapeHtml(i.notes || '')}</small>
        </div>
      </div>`),
    ...lM.map((l) => `
      <div class="item-card" onclick="showTab('loan')" style="cursor:pointer">
        <div>
          <strong>🤝 Prestito: ${escapeHtml(l.item)}</strong> a <strong>${escapeHtml(l.person)}</strong> (${l.returned ? 'Restituito' : 'Ancora fuori'})
        </div>
      </div>`),
    ...vM.map((v, idx) => `
      <div class="item-card vault-card" onclick="showTab('vault')" style="cursor:pointer">
        <div>
          <strong>🔐 Account Vault: ${escapeHtml(v.title)}</strong> — 👤 <span class="mono">${escapeHtml(v.username || '-')}</span>
        </div>
      </div>`)
  ];

  out.innerHTML = cards.length > 0
    ? cards.join('')
    : "<p style=\"color:var(--muted)\">Nessun risultato trovato nell'archivio.</p>";
}

function updateStorageQuotaUI() {
  let totalBytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k) || '';
    totalBytes += (k.length + v.length) * 2;
  }
  const kb = (totalBytes / 1024).toFixed(1);
  const maxKb = 5120;
  const pct = Math.min(100, Math.max(2, Math.round((totalBytes / (maxKb * 1024)) * 100)));

  const txt = document.getElementById('storage-usage-text');
  const bar = document.getElementById('storage-usage-bar');
  if (txt) txt.textContent = `${kb} KB / ~5.000 KB (${pct}%)`;
  if (bar) bar.style.width = pct + '%';
}

function exportUnifiedBackup() {
  const payload = {
    app: 'PersonalOS-Archivio-SecureVault',
    version: 3,
    exportedAt: new Date().toISOString(),
    boxes: state.boxes,
    inventory: state.inventory,
    loans: state.loans,
    encryptedVault: getStoredVault()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'archivio-personale-backup.json';
  a.click();
  showToast('Backup JSON scaricato!');
}

function importUnifiedBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      const source = data.archive && typeof data.archive === 'object' ? data.archive : data;

      state = {
        boxes: Array.isArray(source.boxes) ? source.boxes : [],
        inventory: Array.isArray(source.inventory) ? source.inventory : [],
        loans: Array.isArray(source.loans) ? source.loans : []
      };

      if (data.encryptedVault && data.encryptedVault.ciphertext) {
        localStorage.setItem(KEY_VAULT_DB, JSON.stringify(data.encryptedVault));
        lockVault();
      }

      saveState('Backup ripristinato con successo!');
      alert('Backup ripristinato con successo!');
      e.target.value = '';
    } catch (err) {
      alert('File JSON non valido.');
    }
  };
  r.readAsText(file);
}

function exportArchiveCsv() {
  const rows = [['Sezione', 'Codice/Oggetto', 'Contenitore/Persona', 'Dettagli', 'Quantita/Stato']];
  state.boxes.forEach((b) => rows.push(['Faldone', b.code + ' - ' + b.name, b.loc || '-', (b.items || '').replace(/\n/g, ' | '), '-']));
  state.inventory.forEach((i) => rows.push(['Inventario', i.name, getBoxLabel(i.boxId), i.cat + ' - ' + (i.notes || ''), 'Qta: ' + i.qty + ' (' + i.cond + ')']));
  state.loans.forEach((l) => rows.push(['Prestito', l.item, l.person, 'Uscita: ' + (l.dateStr || '-'), l.returned ? 'Restituito' : 'In prestito']));

  const csv = rows.map((r) => r.map((c) => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'archivio-personale-completo.csv';
  a.click();
}

/* ==========================================================================
   12. PWA INSTALL PROMPT & SERVICE WORKER REGISTRATION
   ========================================================================== */
let deferredPrompt = null;
const installBtn = document.getElementById('btn-install');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.hidden = false;
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// Avvio iniziale
window.addEventListener('DOMContentLoaded', () => {
  const todayInputLoan = document.getElementById('ln-date');
  if (todayInputLoan) todayInputLoan.valueAsDate = new Date();

  checkVaultLockUI();
  renderAll();
  updateStorageQuotaUI();

  const hash = (location.hash || '').replace('#', '');
  if (['dash', 'box', 'inv', 'loan', 'vault', 'src'].includes(hash)) {
    showTab(hash);
  }
});
