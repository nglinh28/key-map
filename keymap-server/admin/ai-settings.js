'use strict';
// Tab "Cài đặt AI": Quản lý các nhà cung cấp AI (OpenAI-compatible endpoints), địa chỉ Base URL,
// khóa API, model và thứ tự ưu tiên khi phân tích độ giật hoặc rà soát tổ hợp.
(() => {
  const { el, icon, pageHead, badge, alert, api, guard, toast, copyText, showModal, confirmModal, alertModal } = window.Ui;


  const PRESETS = [
    {
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      desc: 'Nhiều model phong phú (DeepSeek, Claude, GPT, Llama).'
    },
    {
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      desc: 'Model gpt-4o-mini chính hãng, tốc độ cao và phản hồi ổn định.'
    },
    {
      name: 'Groq Cloud',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      desc: 'Tốc độ phản hồi cực nhanh, có gói miễn phí tiện lợi.'
    },
    {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      desc: 'API trực tiếp từ DeepSeek, tính toán đường cong rất tốt.'
    },
    {
      name: 'Ollama (Local)',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      desc: 'Chạy nội bộ trên máy (localhost), không tốn chi phí và bảo mật.'
    },
    {
      name: 'LAN Server',
      baseUrl: 'http://192.168.4.6:3001/v1',
      model: 'auto',
      desc: 'Máy chủ AI nội bộ trong mạng cục bộ.'
    }
  ];

  const st = {
    providers: [],
    status: { enabled: false, model: '', concurrency: 3 },
    loading: false,
    saving: false,
    dirty: false,
    showKey: new Set(),
    testOut: new Map(), // index -> { text, ok, ms }
    testing: new Set(), // set of indices
    modelsOut: new Map(), // index -> { ok, models, text }
    loadingModels: new Set(), // set of indices
  };

  async function loadData() {
    st.loading = true;
    try {
      const [pRes, sRes] = await Promise.all([
        api('GET', '/ai/providers'),
        api('GET', '/ai/status').catch(() => ({ enabled: false, model: '', concurrency: 3 })),
      ]);
      st.providers = (pRes.providers || []).map((p) => ({
        ...p,
        apiKey: '',
        saved: true,
        dirty: false,
      }));
      // If server only has unconfigured builtin provider, automatically add default editable preset
      if (st.providers.length === 1 && st.providers[0].builtin && !st.providers[0].ready) {
        st.providers.push({
          id: '',
          name: PRESETS[0].name,
          baseUrl: PRESETS[0].baseUrl,
          model: PRESETS[0].model,
          apiKey: '',
          enabled: true,
          builtin: false,
          hasKey: false,
          keyHint: '',
          ready: false,
          saved: false,
          dirty: true,
        });
        st.dirty = true;
      }
      st.status = sRes;
      st.dirty = st.providers.some((p) => p.dirty);

      st.testOut.clear();
      st.testing.clear();
      st.modelsOut.clear();
      st.loadingModels.clear();
    } catch (e) {
      toast('Không tải được danh sách nguồn AI: ' + e.message, true);
    } finally {
      st.loading = false;
    }
  }

  async function loadModels(p, i) {
    if (st.loadingModels.has(i)) return;
    if (!p.baseUrl) {
      st.modelsOut.set(i, { ok: false, text: 'Chưa có địa chỉ Base URL. Vui lòng nhập URL trước.' });
      render();
      return;
    }
    st.loadingModels.add(i);
    st.modelsOut.set(i, { ok: null, text: 'Đang kết nối tới endpoint để lấy danh sách model…' });
    render();

    try {
      const payload = {
        id: p.id || undefined,
        provider: {
          id: p.id || undefined,
          name: p.name || undefined,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey || undefined,
        },
      };
      const r = await api('POST', '/ai/providers/models', payload);
      if (r.ok && Array.isArray(r.models)) {
        if (!r.models.length) {
          st.modelsOut.set(i, { ok: true, models: [], text: 'Endpoint phản hồi nhưng không có model nào được liệt kê.' });
        } else {
          st.modelsOut.set(i, {
            ok: true,
            models: r.models,
            text: `Đã tải ${r.models.length} model khả dụng.`,
          });
          toast(`Đã tìm thấy ${r.models.length} model từ ${p.name || 'endpoint'}.`);
        }
      } else {
        st.modelsOut.set(i, { ok: false, text: r.reason || 'Không tải được danh sách model.' });
      }
    } catch (e) {
      st.modelsOut.set(i, { ok: false, text: e.message || 'Lỗi kết nối khi tải model.' });
    } finally {
      st.loadingModels.delete(i);
      render();
    }
  }


  async function testProvider(p, i) {
    if (st.testing.has(i)) return;
    if (!p.ready && !p.apiKey) {
      st.testOut.set(i, { ok: false, text: 'Chưa có khóa API hoặc địa chỉ. Vui lòng nhập trước.' });
      render();
      return;
    }
    st.testing.add(i);
    st.testOut.set(i, { ok: null, text: 'Đang kiểm tra kết nối tới AI…' });
    render();

    try {
      // If newly typed or edited key exists, test directly; otherwise test saved ID
      // an edited card (a model just picked, a new key or address) is tested as it is on the page; the server keeps the saved key when none is typed
      const payload = p.dirty
        ? { id: p.id, provider: { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey || undefined, model: p.model } }
        : { id: p.id };
      const r = await api('POST', '/ai/providers/test', payload);
      if (r.ok) {
        st.testOut.set(i, {
          ok: true,
          text: `Kết nối thành công! Model phản hồi: ${r.model} (${Math.round(r.ms)}ms)`,
        });
        if (p.dirty && st.providers[i] === p) {
          // "OK → use this model": saved at once, but only when nothing else on the page is waiting to be saved (the whole page is one save)
          const others = st.providers.some((q, k) => k !== i && (q.dirty || q.apiKey));
          if (others || st.saving) {
            st.testOut.set(i, { ok: true, text: `Kết nối thành công với ${r.model} (${Math.round(r.ms)}ms). Chưa lưu: trang còn thay đổi khác, bấm "Lưu tất cả" để dùng model này.` });
          } else {
            st.testing.delete(i);
            const saved = await saveAll();
            st.testOut.set(i, { ok: saved, text: saved ? `Kết nối thành công với ${r.model} (${Math.round(r.ms)}ms) và đã lưu để dùng model này.` : `Kết nối thành công với ${r.model} nhưng chưa lưu được cấu hình (xem thông báo lỗi). Sửa rồi bấm "Lưu tất cả".` });
          }
        }
      } else {
        st.testOut.set(i, {
          ok: false,
          text: r.reason || 'Kiểm tra thất bại',
        });
      }
    } catch (e) {
      st.testOut.set(i, { ok: false, text: e.message || 'Lỗi mạng hoặc server không phản hồi.' });
    } finally {
      st.testing.delete(i);
      render();
    }
  }

  async function saveAll() {
    if (st.saving) return;
    st.saving = true;
    render();
    try {
      const list = st.providers.map((p) => (p.builtin
        ? { id: 'env', enabled: p.enabled }
        : {
            id: p.id || undefined,
            name: p.name || 'AI',
            baseUrl: p.baseUrl || '',
            model: p.model || 'auto',
            apiKey: p.apiKey || '',
            enabled: p.enabled,
          }));

      const r = await api('PUT', '/ai/providers', { providers: list });
      const first = (r.providers || []).find((x) => x.enabled && x.ready);
      st.status = await api('GET', '/ai/status').catch(() => ({ enabled: Boolean(first), model: first ? first.model : '' }));
      toast(first ? `Đã lưu cấu hình AI. Nguồn hoạt động chính: ${first.name}.` : 'Đã lưu cấu hình AI. Lưu ý: Chưa có nguồn nào sẵn sàng.');
      await loadData();
      return true;
    } catch (e) {
      toast('Lưu thất bại: ' + e.message, true);
      return false;
    } finally {
      st.saving = false;
      render();
    }
  }

  function addPreset(preset) {
    if (st.providers.length >= 9) {
      toast('Đã đạt số lượng tối đa nguồn AI (tối đa 8 nguồn thêm).', true);
      return;
    }
    st.providers.push({
      id: '',
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      apiKey: '',
      enabled: true,
      builtin: false,
      hasKey: false,
      keyHint: '',
      ready: false,
      saved: false,
      dirty: true,
    });
    st.dirty = true;
    render();
    toast(`Đã thêm mẫu ${preset.name}. Hãy nhập khóa API và bấm "Lưu tất cả".`);
  }

  function addCustom() {
    addPreset({ name: 'Nguồn AI mới', baseUrl: 'https://', model: 'auto' });
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= st.providers.length) return;
    const temp = st.providers[i];
    st.providers[i] = st.providers[j];
    st.providers[j] = temp;
    st.providers[i].dirty = true;
    st.providers[j].dirty = true;
    st.dirty = true;

    // Swap state keyed by index
    const ti = st.testOut.get(i);
    const tj = st.testOut.get(j);
    if (ti !== undefined) st.testOut.set(j, ti); else st.testOut.delete(j);
    if (tj !== undefined) st.testOut.set(i, tj); else st.testOut.delete(i);

    const mi = st.modelsOut.get(i);
    const mj = st.modelsOut.get(j);
    if (mi !== undefined) st.modelsOut.set(j, mi); else st.modelsOut.delete(j);
    if (mj !== undefined) st.modelsOut.set(i, mj); else st.modelsOut.delete(i);

    const ski = st.showKey.has(i);
    const skj = st.showKey.has(j);
    if (ski) st.showKey.add(j); else st.showKey.delete(j);
    if (skj) st.showKey.add(i); else st.showKey.delete(i);

    render();
  }

  function shiftStateAfterRemove(removedIdx) {
    const newTestOut = new Map();
    for (const [k, v] of st.testOut) {
      if (k < removedIdx) newTestOut.set(k, v);
      else if (k > removedIdx) newTestOut.set(k - 1, v);
    }
    st.testOut = newTestOut;

    const newModelsOut = new Map();
    for (const [k, v] of st.modelsOut) {
      if (k < removedIdx) newModelsOut.set(k, v);
      else if (k > removedIdx) newModelsOut.set(k - 1, v);
    }
    st.modelsOut = newModelsOut;

    const newShowKey = new Set();
    for (const k of st.showKey) {
      if (k < removedIdx) newShowKey.add(k);
      else if (k > removedIdx) newShowKey.add(k - 1);
    }
    st.showKey = newShowKey;
  }

  async function remove(i) {
    const p = st.providers[i];
    if (p.builtin) return;
    const ok = await confirmModal({
      title: 'Xóa nguồn AI?',
      tone: 'danger',
      danger: true,
      body: `Bạn có chắc muốn xóa cấu hình nguồn AI "${p.name || 'này'}"?`,
      confirmLabel: 'Xóa',
      cancelLabel: 'Hủy',
    });
    if (ok) {
      st.providers.splice(i, 1);
      shiftStateAfterRemove(i);
      st.dirty = true;
      render();
    }
  }

  async function discardOk() {
    if (!st.dirty) return true;
    const ok = await confirmModal({
      title: 'Bỏ thay đổi chưa lưu?',
      tone: 'warn',
      danger: true,
      body: 'Bạn có các thay đổi chưa lưu trong Cài đặt AI. Bỏ qua các thay đổi này?',
      confirmLabel: 'Bỏ thay đổi',
      cancelLabel: 'Ở lại',
    });
    if (ok) st.dirty = false;
    return ok;
  }

  let rootNode = null;

  function render() {
    if (!rootNode) return;
    rootNode.replaceChildren(buildContent());
  }

  function buildContent() {
    const box = el('div', { class: 'ai-settings-page' });

    // 1. Page Header
    const head = pageHead(
      'Cài đặt AI',
      'Cấu hình các nguồn AI (tương thích OpenAI) dùng để phân tích độ giật, đề xuất tổ hợp và rà soát mốc chuẩn. Hệ thống tự động chuyển tiếp sang nguồn tiếp theo khi nguồn đầu tiên gặp sự cố.',
      el('div', { class: 'row gap-2' },
        el('button', {
          type: 'button',
          class: 'btn small',
          onclick: guard(loadData),
          disabled: st.loading || st.saving,
        }, icon('refresh'), st.loading ? 'Đang đọc…' : 'Tải lại'),
        el('button', {
          type: 'button',
          class: 'btn small primary',
          onclick: guard(saveAll),
          disabled: st.saving,
        }, icon('check'), st.saving ? 'Đang lưu…' : 'Lưu tất cả cấu hình')
      )
    );

    // 2. Status Hero Banner
    const isReady = st.status && st.status.enabled;
    const activeProvider = st.providers.find((p) => p.enabled && (p.ready || (p.apiKey && p.baseUrl)));
    const hero = el('div', { class: `ai-status-hero ${isReady ? 'ok' : 'warn'}` },
      el('div', { class: 'ai-status-hero-info' },
        el('div', { class: 'ai-status-badge-row' },
          badge(isReady ? 'AI ĐANG HOẠT ĐỘNG' : 'AI CHƯA ĐƯỢC BẬT', isReady ? 'ok' : 'danger', { dot: true }),
          activeProvider ? el('span', { class: 'muted text-xs' }, `Ưu tiên hàng đầu: ${activeProvider.name}`) : null,
          st.status.model ? badge(`Model: ${st.status.model}`, 'accent') : null
        ),
        el('h2', {}, isReady ? 'Các tính năng AI trên web đã sẵn sàng' : 'Chưa có nhà cung cấp AI nào được kích hoạt'),
        el('p', {}, isReady
          ? `Hệ thống sẽ hỏi nguồn ưu tiên cao nhất đang bật (${activeProvider ? activeProvider.name : 'AI'}). Bạn có thể sử dụng "Tính mốc cả bảng", "Tính mốc (server + AI)" và Gợi ý trong tab Phân tích cache.`
          : 'Để sử dụng các chức năng "Tính mốc cả bảng", "Tính mốc (server + AI)": Vui lòng thêm hoặc bật một nguồn AI bên dưới, nhập Địa chỉ Base URL cùng API Key hợp lệ rồi bấm "Lưu tất cả cấu hình".')
      ),
      el('div', { class: 'row' },
        el('button', {
          type: 'button',
          class: `btn ${isReady ? 'ghost' : 'primary'}`,
          onclick: () => {
            const firstInput = box.querySelector('input[type="password"], input[type="text"]');
            if (firstInput) firstInput.focus();
            else addPreset(PRESETS[0]);
          },
        }, icon(isReady ? 'pencil' : 'plus'), isReady ? 'Chỉnh sửa nguồn' : 'Kích hoạt AI ngay')
      )
    );

    // 3. Quick Presets Bar
    const presetsBox = el('div', { class: 'ai-presets-box' },
      el('div', { class: 'title' }, 'Thêm nhanh từ mẫu nhà cung cấp phổ biến:'),
      el('div', { class: 'ai-presets' },
        ...PRESETS.map((p) => el('button', {
          type: 'button',
          class: 'btn small',
          title: p.desc,
          onclick: () => addPreset(p),
        }, icon('plus'), p.name)),
        el('button', {
          type: 'button',
          class: 'btn small ghost',
          onclick: addCustom,
        }, icon('plus'), 'Tùy chỉnh khác…')
      )
    );

    // 4. Provider Cards
    const cards = st.providers.map((p, i) => {
      const isFirst = i === 0;
      const isLast = i === st.providers.length - 1;
      const tState = st.testOut.get(i);
      const isTesting = st.testing.has(i);

      // Card Header
      const headLeft = el('div', { class: 'ai-card-title-group' },
        el('span', { class: 'ai-card-index' }, String(i + 1)),
        el('span', { class: 'font-semibold text-base' }, p.name || 'Nguồn chưa đặt tên'),
        p.builtin ? badge('Mặc định từ server', 'accent') : null,
        p.enabled ? badge('Đang bật', 'ok') : badge('Đã tắt', 'warn'),
        p.dirty || !p.saved ? badge('Chưa lưu', 'warn') : null,
        !p.builtin && !p.ready && !p.apiKey ? badge('Chưa có API Key', 'danger') : null,
        p.ready ? badge('Sẵn sàng', 'ok') : null
      );

      const headRight = el('div', { class: 'ai-card-actions' },
        el('label', { class: 'row items-center gap-2 cursor-pointer', title: 'Bật hoặc tắt nguồn này' },
          el('input', {
            type: 'checkbox',
            checked: p.enabled,
            onchange: (e) => {
              p.enabled = e.target.checked;
              p.dirty = true;
              st.dirty = true;
              render();
            },
          }),
          el('span', { class: 'text-sm font-medium' }, 'Bật sử dụng')
        ),
        el('button', {
          type: 'button',
          class: 'btn icon small ghost',
          title: 'Đẩy lên vị trí ưu tiên cao hơn',
          disabled: isFirst,
          onclick: () => move(i, -1),
        }, icon('arrowUp')),
        el('button', {
          type: 'button',
          class: 'btn icon small ghost',
          title: 'Đẩy xuống vị trí ưu tiên thấp hơn',
          disabled: isLast,
          onclick: () => move(i, 1),
        }, icon('arrowDown')),
        p.builtin ? null : el('button', {
          type: 'button',
          class: 'btn icon small ghost danger',
          title: 'Xóa nguồn AI này',
          onclick: () => remove(i),
        }, icon('trash'))
      );

      const cardHead = el('div', { class: 'ai-card-head' }, headLeft, headRight);

      // Card Fields
      let cardBody;
      if (p.builtin) {
        cardBody = el('div', { class: 'py-2' },
          el('p', { class: 'muted text-sm mb-3' },
            'Nguồn FreeLLMAPI mặc định của máy chủ (được cấu hình qua biến môi trường AI_BASE_URL và AI_API_KEY). Địa chỉ và khóa API thực tế được bảo mật trên máy chủ.'
          ),
          !p.ready ? el('div', { class: 'row gap-2 items-center flex-wrap' },
            el('span', { class: 'text-xs text-danger font-medium' }, 'Máy chủ chưa thiết lập biến môi trường.'),
            el('button', {
              type: 'button',
              class: 'btn small primary',
              onclick: () => addPreset(PRESETS[0]),
            }, icon('plus'), 'Thêm cấu hình AI (OpenRouter, OpenAI, v.v...)')
          ) : null
        );
      } else {

        // Custom Provider Inputs
        const nameInput = el('input', {
          type: 'text',
          value: p.name || '',
          placeholder: 'Ví dụ: OpenRouter, Groq, Ollama...',
          maxlength: '60',
          oninput: (e) => { p.name = e.target.value; p.dirty = true; st.dirty = true; },
        });

        const urlInput = el('input', {
          type: 'url',
          value: p.baseUrl || '',
          placeholder: 'https://api.openai.com/v1',
          oninput: (e) => { p.baseUrl = e.target.value.trim(); p.dirty = true; st.dirty = true; },
        });

        const mState = st.modelsOut.get(i);
        const isModelLoading = st.loadingModels.has(i);

        const modelInput = el('input', {
          type: 'text',
          value: p.model || '',
          placeholder: 'gpt-4o-mini, deepseek/deepseek-chat, auto...',
          oninput: (e) => { p.model = e.target.value.trim(); p.dirty = true; st.dirty = true; },
        });

        const loadModelBtn = el('button', {
          type: 'button',
          class: 'btn small',
          disabled: isModelLoading,
          title: 'Kết nối tới endpoint và lấy danh sách model được hỗ trợ',
          onclick: () => loadModels(p, i),
        }, icon(isModelLoading ? 'refresh' : 'sparkles'), isModelLoading ? 'Đang tải…' : 'Tải model');

        const modelRow = el('div', { class: 'row gap-2' },
          el('div', { class: 'flex-1' }, modelInput),
          loadModelBtn
        );

        let modelPicker = null;
        if (mState && mState.models && mState.models.length > 0) {
          modelPicker = el('select', {
            class: 'ai-model-select',
            'data-i': i,
            onchange: (e) => {
              if (e.target.value) {
                p.model = e.target.value;
                modelInput.value = e.target.value;
                p.dirty = true;
                st.dirty = true;
                st.testOut.delete(i); // the old test was for another model
                const y = window.scrollY;
                render();
                window.scrollTo(0, y);
                const again = document.querySelector(`.ai-model-select[data-i="${i}"]`); // the same card, drawn again: keep the keyboard where it was
                if (again) again.focus({ preventScroll: true });
              }
            },
          },
          el('option', { value: '' }, `-- Chọn nhanh từ ${mState.models.length} model khả dụng --`),
          ...mState.models.map((m) => el('option', { value: m, selected: p.model === m }, m))
          );
        }

        let modelFeedback = null;
        if (mState) {
          modelFeedback = el('div', {
            class: `ai-model-feedback ${mState.ok === true ? 'text-ok' : mState.ok === false ? 'text-danger' : 'muted'}`,
          },
          mState.ok === true ? icon('check') : mState.ok === false ? icon('alert') : icon('refresh'),
          el('span', {}, mState.text)
          );
        }

        const keyShowing = st.showKey.has(i);
        const keyInput = el('input', {
          type: keyShowing ? 'text' : 'password',
          autocomplete: 'new-password',
          value: p.apiKey || '',
          placeholder: p.hasKey ? `Đang lưu (${p.keyHint}) - để trống nếu không đổi` : 'Nhập API Key bí mật...',
          oninput: (e) => { p.apiKey = e.target.value; p.dirty = true; st.dirty = true; },
        });

        const toggleKeyBtn = el('button', {
          type: 'button',
          class: 'ai-input-btn',
          title: keyShowing ? 'Ẩn khóa API' : 'Xem khóa API',
          onclick: () => {
            if (st.showKey.has(i)) st.showKey.delete(i);
            else st.showKey.add(i);
            render();
          },
        }, icon(keyShowing ? 'eyeOff' : 'eye'));

        const keyWrap = el('div', { class: 'ai-input-with-button' }, keyInput, toggleKeyBtn);

        cardBody = el('div', { class: 'ai-form-grid' },
          el('div', { class: 'ai-form-field' },
            el('label', {}, 'Tên nhà cung cấp / Nhãn gợi nhớ'),
            nameInput,
            el('span', { class: 'field-hint' }, 'Tên hiển thị để dễ phân biệt trong danh sách.')
          ),
          el('div', { class: 'ai-form-field' },
            el('label', {}, 'Địa chỉ API Base URL (tương thích OpenAI, tới /v1)'),
            urlInput,
            el('span', { class: 'field-hint' }, 'Ví dụ: https://openrouter.ai/api/v1 hoặc https://api.openai.com/v1')
          ),
          el('div', { class: 'ai-form-field' },
            el('label', {}, 'Mã Model AI'),
            modelRow,
            modelPicker,
            modelFeedback || el('span', { class: 'field-hint' }, 'Tên model xử lý (như gpt-4o-mini, deepseek-chat hoặc bấm "Tải model" để chọn).')
          ),

          el('div', { class: 'ai-form-field' },
            el('label', {}, 'Khóa API (API Key)'),
            keyWrap,
            el('span', { class: 'field-hint' },
              p.hasKey && !p.apiKey
                ? `Đã lưu an toàn (${p.keyHint}). Để trống ô này sẽ giữ nguyên khóa cũ.`
                : 'Khóa được mã hóa lưu trữ trên server, không lộ ra phiên duyệt web.'
            )
          )
        );
      }

      // Card Foot: Test Button & Output
      const testBtn = el('button', {
        type: 'button',
        class: 'btn small',
        disabled: isTesting,
        onclick: () => testProvider(p, i),
      }, icon('sparkles'), isTesting ? 'Đang thử nghiệm…' : 'Thử kết nối (Ping Test)');

      let testFeedback = null;
      if (tState) {
        testFeedback = el('div', {
          class: `ai-test-feedback text-sm font-medium ${tState.ok === true ? 'text-ok' : tState.ok === false ? 'text-danger' : 'muted'}`,
        },
        tState.ok === true ? icon('check') : tState.ok === false ? icon('alert') : icon('refresh'),
        el('span', {}, tState.text));
      }

      const cardFoot = el('div', { class: 'ai-card-foot' }, testBtn, testFeedback || el('span', { class: 'muted text-xs' }, 'Bấm thử để kiểm tra xem API Key và địa chỉ có hoạt động không.'));

      return el('div', {
        class: `ai-provider-card ${i === 0 && p.enabled ? 'active-first' : ''} ${!p.enabled ? 'disabled-provider' : ''} ${p.dirty ? 'dirty' : ''}`,
      }, cardHead, cardBody, cardFoot);
    });

    // 5. Sticky Save Dock (Action Bar)
    const saveDock = el('div', { class: 'ai-save-dock' },
      el('div', { class: 'ai-save-dock-info' },
        st.dirty ? badge('Có thay đổi chưa lưu', 'warn', { dot: true }) : badge('Đã đồng bộ', 'ok'),
        el('span', {}, `${st.providers.length} nhà cung cấp cấu hình · ${st.providers.filter((p) => p.enabled).length} đang bật.`)
      ),
      el('div', { class: 'row gap-2' },
        el('button', {
          type: 'button',
          class: 'btn small',
          disabled: st.saving,
          onclick: addCustom,
        }, icon('plus'), 'Thêm nguồn mới'),
        el('button', {
          type: 'button',
          class: 'btn small primary',
          disabled: st.saving,
          onclick: guard(saveAll),
        }, icon('check'), st.saving ? 'Đang lưu…' : 'Lưu tất cả cấu hình')
      )
    );

    // 6. Security Note Section
    const infoCard = el('div', { class: 'card my-4' },
      el('h3', { class: 'font-semibold text-sm mb-2' }, 'Về bảo mật và nguyên lý hoạt động của AI:'),
      el('ul', { class: 'muted text-sm space-y-1' },
        el('li', {}, '• Khóa API được lưu trữ trên server tại tệp ai-providers.json với quyền 0600. Trình duyệt không bao giờ nhận lại khóa API đầy đủ.'),
        el('li', {}, '• Cơ chế chuyển tiếp ưu tiên: Yêu cầu AI luôn gửi tới nguồn đứng đầu tiên đang bật. Nếu nguồn đó gặp lỗi (hết tiền, quá tải HTTP 429/500, mạng chập chờn...), hệ thống tự động gọi tiếp nguồn số 2, số 3.'),
        el('li', {}, '• Dữ liệu gửi đi chỉ là thông số độ giật của súng (toạ độ ms và độ kéo) cùng danh sách phụ kiện; tuyệt đối không gửi sơ đồ phím, tài khoản hay thông tin thiết bị cá nhân.')
      )
    );

    box.append(head, hero, presetsBox, ...cards, saveDock, infoCard);
    return box;
  }

  window.AiSettings = {
    async view() {
      rootNode = el('div', {});
      await loadData();
      render();
      return rootNode;
    },
    discardOk,
  };
})();
