(function () {
  "use strict";

  const data = window.LEARNING_TREE;
  const codeTemplates = window.CODE_TEMPLATES || {};
  const ICON = "assets/icons/";
  const NODE_W = 210;
  const NODE_H = 76;
  const X_GAP = 98;
  const Y_GAP = 20;
  const PADDING = 48;
  const STORAGE_KEY = "control-roadmap-progress-v1";

  const elements = {
    canvas: document.getElementById("canvas"),
    world: document.getElementById("world"),
    nodes: document.getElementById("nodes-layer"),
    svg: document.getElementById("connections"),
    outline: document.getElementById("outline-tree"),
    details: document.getElementById("details"),
    navigator: document.getElementById("navigator"),
    backdrop: document.getElementById("backdrop"),
    search: document.getElementById("search-input"),
    searchResults: document.getElementById("search-results"),
    clearSearch: document.getElementById("clear-search"),
    scope: document.getElementById("scope-select"),
    nodeCount: document.getElementById("node-count"),
    progressLabel: document.getElementById("progress-label"),
    progressBar: document.getElementById("progress-bar"),
    zoomLabel: document.getElementById("zoom-label"),
    empty: document.getElementById("canvas-empty"),
    detailType: document.getElementById("detail-type"),
    detailTitle: document.getElementById("detail-title"),
    detailContent: document.getElementById("detail-content"),
    complete: document.getElementById("completion-checkbox"),
    fileInput: document.getElementById("progress-file"),
    toast: document.getElementById("toast-region")
  };

  const state = {
    nodesById: new Map(),
    parents: new Map(),
    flat: [],
    expanded: new Set(["root"]),
    completed: loadProgress(),
    selectedId: "root",
    scope: "all",
    query: "",
    transform: { x: 24, y: 24, scale: 1 },
    layout: new Map(),
    worldSize: { width: 0, height: 0 },
    dragging: false,
    dragOrigin: null,
    hasInitialFit: false
  };

  indexTree(data, null, 0, []);
  buildScopeOptions();
  bindEvents();
  render();
  requestAnimationFrame(function () {
    fitView();
    state.hasInitialFit = true;
  });

  function indexTree(node, parent, depth, path) {
    node.depth = depth;
    node.path = path.concat(node.title);
    state.nodesById.set(node.id, node);
    state.flat.push(node);
    if (parent) state.parents.set(node.id, parent.id);
    (node.children || []).forEach(function (child) { indexTree(child, node, depth + 1, node.path); });
  }

  function buildScopeOptions() {
    const options = [{ id: "all", title: "全部知识" }].concat(data.children.map(function (node) {
      return { id: node.id, title: node.title };
    }));
    elements.scope.innerHTML = options.map(function (option) {
      return "<option value=\"" + escapeAttr(option.id) + "\">" + escapeHtml(option.title) + "</option>";
    }).join("");
  }

  function bindEvents() {
    document.getElementById("expand-all").addEventListener("click", expandAll);
    document.getElementById("collapse-all").addEventListener("click", collapseAll);
    document.getElementById("zoom-in").addEventListener("click", function () { zoomAt(1.16); });
    document.getElementById("zoom-out").addEventListener("click", function () { zoomAt(0.86); });
    document.getElementById("fit-view").addEventListener("click", fitView);
    document.getElementById("reset-filter").addEventListener("click", resetFilters);
    document.getElementById("export-progress").addEventListener("click", exportProgress);
    document.getElementById("import-progress").addEventListener("click", function () { elements.fileInput.click(); });
    document.getElementById("clear-progress").addEventListener("click", clearProgress);
    elements.fileInput.addEventListener("change", importProgress);
    elements.complete.addEventListener("change", toggleCompletion);
    elements.scope.addEventListener("change", function () {
      state.scope = elements.scope.value;
      if (state.scope !== "all") {
        state.expanded.add("root");
        state.expanded.add(state.scope);
        if (!belongsToScope(state.selectedId, state.scope)) state.selectedId = state.scope;
      }
      render();
      requestAnimationFrame(fitView);
    });

    elements.search.addEventListener("input", function () {
      state.query = elements.search.value.trim();
      elements.clearSearch.hidden = !state.query;
      renderSearchResults();
      renderCanvas();
    });
    elements.search.addEventListener("focus", renderSearchResults);
    elements.clearSearch.addEventListener("click", function () {
      elements.search.value = "";
      state.query = "";
      elements.clearSearch.hidden = true;
      elements.searchResults.hidden = true;
      renderCanvas();
      elements.search.focus();
    });
    document.addEventListener("pointerdown", function (event) {
      if (!event.target.closest(".search-wrap")) elements.searchResults.hidden = true;
    });

    elements.canvas.addEventListener("wheel", onWheel, { passive: false });
    elements.canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("resize", debounce(function () {
      applyTransform();
      if (window.innerWidth < 768) closeDrawers();
    }, 120));

    document.getElementById("mobile-nav-button").addEventListener("click", function () { openDrawer("nav"); });
    document.getElementById("mobile-detail-button").addEventListener("click", function () { openDrawer("detail"); });
    document.getElementById("close-nav").addEventListener("click", closeDrawers);
    document.getElementById("close-detail").addEventListener("click", closeDrawers);
    elements.backdrop.addEventListener("click", closeDrawers);
  }

  function render() {
    renderOutline();
    renderCanvas();
    renderDetails();
    renderProgress();
  }

  function currentRootChildren() {
    if (state.scope === "all") return data.children;
    const node = state.nodesById.get(state.scope);
    return node ? [node] : [];
  }

  function visibleChildren(node) {
    if (!state.expanded.has(node.id)) return [];
    if (node.id === "root") return currentRootChildren();
    return node.children || [];
  }

  function calculateLayout() {
    state.layout.clear();
    let nextY = PADDING;
    let maxDepth = 0;

    function walk(node, depth) {
      maxDepth = Math.max(maxDepth, depth);
      const children = visibleChildren(node);
      let y;
      if (!children.length) {
        y = nextY;
        nextY += NODE_H + Y_GAP;
      } else {
        children.forEach(function (child) { walk(child, depth + 1); });
        const first = state.layout.get(children[0].id).y;
        const last = state.layout.get(children[children.length - 1].id).y;
        y = (first + last) / 2;
      }
      state.layout.set(node.id, { x: PADDING + depth * (NODE_W + X_GAP), y: y, depth: depth });
    }

    walk(data, 0);
    state.worldSize.width = PADDING * 2 + (maxDepth + 1) * NODE_W + maxDepth * X_GAP;
    state.worldSize.height = Math.max(240, nextY - Y_GAP + PADDING);
  }

  function renderCanvas() {
    calculateLayout();
    const matchIds = new Set(searchMatches().map(function (node) { return node.id; }));
    const nodeFragments = [];
    const edgeFragments = [];

    state.layout.forEach(function (position, id) {
      const node = state.nodesById.get(id);
      const children = visibleChildren(node);
      const progress = descendantProgress(node);
      const classes = ["tree-node"];
      if (state.selectedId === id) classes.push("selected");
      if (state.completed.has(id)) classes.push("completed");
      if (state.query && matchIds.has(id)) classes.push("search-match");
      const type = escapeHtml(node.type || "知识节点");
      const level = escapeHtml(node.level || "");
      nodeFragments.push(
        "<article class=\"" + classes.join(" ") + "\" data-node-id=\"" + escapeAttr(id) + "\" data-depth=\"" + position.depth + "\" " +
        "style=\"left:" + position.x + "px;top:" + position.y + "px;--node-progress:" + progress.percent + "%\">" +
          "<button class=\"node-main\" type=\"button\" data-action=\"select\" aria-label=\"查看 " + escapeAttr(node.title) + "\">" +
            "<span class=\"node-topline\"><span class=\"node-type\">" + type + "</span>" + (level ? "<span class=\"node-level\">" + level + "</span>" : "") + "</span>" +
            "<strong class=\"node-title\">" + highlight(node.title, state.query) + "</strong>" +
            "<span class=\"node-summary\">" + escapeHtml(node.summary || "") + "</span>" +
          "</button>" +
          (node.children && node.children.length ? "<button class=\"node-expand " + (state.expanded.has(id) ? "expanded" : "") + "\" type=\"button\" data-action=\"toggle\" title=\"" + (state.expanded.has(id) ? "收起分支" : "展开分支") + "\" aria-label=\"" + (state.expanded.has(id) ? "收起" : "展开") + escapeAttr(node.title) + "\"><img src=\"" + ICON + "chevron-right.svg\" alt=\"\"></button>" : "") +
          "<span class=\"node-progress\"></span>" +
        "</article>"
      );

      children.forEach(function (child) {
        const childPos = state.layout.get(child.id);
        if (!childPos) return;
        const x1 = position.x + NODE_W;
        const y1 = position.y + NODE_H / 2;
        const x2 = childPos.x;
        const y2 = childPos.y + NODE_H / 2;
        const bend = Math.max(34, (x2 - x1) * .48);
        const active = isOnSelectedPath(node.id, child.id) ? " active" : "";
        edgeFragments.push("<path class=\"connection-path" + active + "\" d=\"M " + x1 + " " + y1 + " C " + (x1 + bend) + " " + y1 + ", " + (x2 - bend) + " " + y2 + ", " + x2 + " " + y2 + "\"></path>");
      });
    });

    elements.nodes.innerHTML = nodeFragments.join("");
    elements.svg.setAttribute("width", state.worldSize.width);
    elements.svg.setAttribute("height", state.worldSize.height);
    elements.svg.setAttribute("viewBox", "0 0 " + state.worldSize.width + " " + state.worldSize.height);
    elements.svg.innerHTML = edgeFragments.join("");
    elements.world.style.width = state.worldSize.width + "px";
    elements.world.style.height = state.worldSize.height + "px";
    elements.empty.hidden = state.layout.size > 1;
    elements.nodes.querySelectorAll("[data-action]").forEach(function (button) {
      button.addEventListener("click", onNodeAction);
    });
    applyTransform();
    elements.nodeCount.textContent = state.layout.size + " 个当前可见 / " + state.flat.length + " 个总节点";
  }

  function onNodeAction(event) {
    event.stopPropagation();
    const article = event.currentTarget.closest(".tree-node");
    const id = article.dataset.nodeId;
    if (event.currentTarget.dataset.action === "toggle") {
      toggleExpanded(id);
    } else {
      selectNode(id, false);
    }
  }

  function toggleExpanded(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderOutline();
    renderCanvas();
  }

  function renderOutline() {
    const rows = [];
    function walk(node, depth) {
      const children = visibleChildren(node);
      const hasChildren = node.children && node.children.length;
      const progress = descendantProgress(node);
      const statusClass = state.completed.has(node.id) ? "done" : (progress.done > 0 ? "partial" : "");
      rows.push(
        "<div class=\"outline-row " + (state.selectedId === node.id ? "selected" : "") + "\" style=\"padding-left:" + (depth * 13) + "px\" data-node-id=\"" + escapeAttr(node.id) + "\">" +
          "<button class=\"outline-toggle " + (hasChildren ? "" : "leaf") + " " + (state.expanded.has(node.id) ? "expanded" : "") + "\" type=\"button\" data-outline-action=\"toggle\" aria-label=\"展开或收起 " + escapeAttr(node.title) + "\"><img src=\"" + ICON + "chevron-right.svg\" alt=\"\"></button>" +
          "<button class=\"outline-select\" type=\"button\" data-outline-action=\"select\">" +
            "<span class=\"outline-status " + statusClass + "\" style=\"--progress:" + progress.percent + "%\"></span>" +
            "<span>" + escapeHtml(node.title) + "</span>" +
            (hasChildren ? "<span class=\"outline-count\">" + progress.done + "/" + progress.total + "</span>" : "") +
          "</button>" +
        "</div>"
      );
      children.forEach(function (child) { walk(child, depth + 1); });
    }
    walk(data, 0);
    elements.outline.innerHTML = rows.join("");
    elements.outline.querySelectorAll("[data-outline-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        const id = button.closest(".outline-row").dataset.nodeId;
        if (button.dataset.outlineAction === "toggle") toggleExpanded(id);
        else selectNode(id, true);
      });
    });
  }

  function renderDetails() {
    const node = state.nodesById.get(state.selectedId) || data;
    elements.detailType.textContent = node.type || "知识节点";
    elements.detailTitle.textContent = node.title;
    elements.complete.checked = state.completed.has(node.id);
    elements.complete.disabled = node.id === "root";

    const metadata = [
      ["学习级别", node.level || "按项目"],
      ["学习方式", node.duration || "按前置关系推进"],
      ["子节点", String((node.children || []).length)],
      ["完成情况", descendantProgress(node).done + " / " + descendantProgress(node).total]
    ];

    let html = "<p class=\"detail-summary\">" + escapeHtml(node.summary || "") + "</p>";
    html += "<div class=\"detail-metadata\">" + metadata.map(function (item) {
      return "<div class=\"metadata-item\"><span>" + escapeHtml(item[0]) + "</span><strong>" + escapeHtml(item[1]) + "</strong></div>";
    }).join("") + "</div>";

    const ancestors = getAncestors(node.id).concat(node.id).map(function (id) { return state.nodesById.get(id); });
    html += "<section class=\"detail-section\"><h3>所在路径</h3><div class=\"ancestor-path\">" + ancestors.map(function (entry) {
      return "<button type=\"button\" data-detail-node=\"" + escapeAttr(entry.id) + "\">" + escapeHtml(entry.title) + "</button>";
    }).join("") + "</div></section>";

    html += detailList("前置知识", node.prerequisites);
    html += detailList("核心知识", node.knowledge);
    html += detailList("相关算法", node.algorithms);
    html += detailList("必须实操", node.tasks);
    html += detailList("验收标准", node.acceptance);
    html += detailList("常见坑", node.pitfalls);
    html += detailList("典型现象", node.symptoms);
    html += renderCodeTemplates(node);
    if (node.source && !location.hostname.endsWith("github.io")) {
      html += "<section class=\"detail-section\"><h3>原始资料</h3><a class=\"source-link\" href=\"" + escapeAttr(node.source) + "\"><img src=\"" + ICON + "external-link.svg\" alt=\"\">打开对应 Markdown 文档</a></section>";
    }
    if (node.children && node.children.length) {
      html += "<section class=\"detail-section\"><h3>下级节点</h3><ul>" + node.children.map(function (child) {
        return "<li><button class=\"inline-node-link\" type=\"button\" data-detail-node=\"" + escapeAttr(child.id) + "\">" + escapeHtml(child.title) + "</button>：" + escapeHtml(child.summary || "") + "</li>";
      }).join("") + "</ul></section>";
    }
    elements.detailContent.innerHTML = html;
    elements.detailContent.querySelectorAll("[data-detail-node]").forEach(function (button) {
      button.addEventListener("click", function () { selectNode(button.dataset.detailNode, true); });
    });
    elements.detailContent.querySelectorAll("[data-copy-template]").forEach(function (button) {
      button.addEventListener("click", function () {
        const index = Number(button.dataset.copyTemplate);
        const template = (codeTemplates[node.id] || [])[index];
        if (template) copyTemplate(template.code, button);
      });
    });
  }

  function renderCodeTemplates(node) {
    const entries = codeTemplates[node.id] || [];
    if (!entries.length) return "";
    return "<section class=\"detail-section template-section\"><h3>可复制代码模板</h3>" +
      "<p class=\"template-notice\">先读“必须修改”。模板提供可靠算法骨架，不包含特定开发板的引脚和驱动初始化。</p>" +
      entries.map(function (entry, index) {
        const sources = (entry.sources || []).map(function (source) {
          return "<a href=\"" + escapeAttr(source.url) + "\" target=\"_blank\" rel=\"noopener noreferrer\"><img src=\"" + ICON + "external-link.svg\" alt=\"\">" + escapeHtml(source.label) + "</a>";
        }).join("");
        return "<article class=\"code-template\">" +
          "<div class=\"template-heading\"><div><span>" + escapeHtml(entry.language) + "</span><strong>" + escapeHtml(entry.title) + "</strong></div>" +
          "<button class=\"copy-button\" type=\"button\" data-copy-template=\"" + index + "\"><img src=\"" + ICON + "copy.svg\" alt=\"\"><span>复制代码</span></button></div>" +
          "<p class=\"template-summary\">" + escapeHtml(entry.summary) + "</p>" +
          "<dl class=\"template-boundary\"><div><dt>可直接复用</dt><dd>" + escapeHtml(entry.reusable) + "</dd></div>" +
          "<div><dt>必须修改</dt><dd>" + escapeHtml(entry.adapt) + "</dd></div></dl>" +
          "<pre><code>" + escapeHtml(entry.code) + "</code></pre>" +
          detailList("代码讲解", entry.explanation) +
          (sources ? "<div class=\"template-sources\"><span>依据来源</span>" + sources + "</div>" : "") +
        "</article>";
      }).join("") + "</section>";
  }

  async function copyTemplate(code, button) {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
        copied = true;
      }
    } catch (error) {
      copied = false;
    }
    if (!copied) {
      const area = document.createElement("textarea");
      area.value = code;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    }
    if (!copied) {
      showToast("复制失败，请在代码区手动全选复制。", true);
      return;
    }
    const label = button.querySelector("span");
    const oldText = label.textContent;
    label.textContent = "已复制";
    button.classList.add("copied");
    setTimeout(function () {
      label.textContent = oldText;
      button.classList.remove("copied");
    }, 1500);
    showToast("代码模板已复制。", false);
  }

  function detailList(title, items) {
    if (!items || !items.length) return "";
    return "<section class=\"detail-section\"><h3>" + escapeHtml(title) + "</h3><ul>" + items.map(function (item) {
      return "<li>" + escapeHtml(String(item)) + "</li>";
    }).join("") + "</ul></section>";
  }

  function selectNode(id, center) {
    if (!state.nodesById.has(id)) return;
    state.selectedId = id;
    if (center) revealNode(id);
    renderOutline();
    renderCanvas();
    renderDetails();
    if (center) requestAnimationFrame(function () { centerNode(id); });
    if (window.innerWidth < 768) openDrawer("detail");
  }

  function revealNode(id) {
    getAncestors(id).forEach(function (ancestorId) { state.expanded.add(ancestorId); });
    const topBranch = getAncestors(id).find(function (ancestorId) { return state.parents.get(ancestorId) === "root"; });
    if (state.scope !== "all" && topBranch && state.scope !== topBranch) {
      state.scope = topBranch;
      elements.scope.value = topBranch;
    }
  }

  function renderProgress() {
    const completable = state.flat.filter(function (node) { return node.id !== "root"; });
    const done = completable.filter(function (node) { return state.completed.has(node.id); }).length;
    const percent = completable.length ? Math.round(done / completable.length * 100) : 0;
    elements.progressLabel.textContent = done + " / " + completable.length;
    elements.progressBar.style.transform = "scaleX(" + (percent / 100) + ")";
  }

  function descendantProgress(node) {
    const descendants = [];
    function collect(current) {
      (current.children || []).forEach(function (child) {
        descendants.push(child);
        collect(child);
      });
    }
    collect(node);
    if (!descendants.length) {
      return { done: state.completed.has(node.id) ? 1 : 0, total: 1, percent: state.completed.has(node.id) ? 100 : 0 };
    }
    const done = descendants.filter(function (entry) { return state.completed.has(entry.id); }).length;
    return { done: done, total: descendants.length, percent: Math.round(done / descendants.length * 100) };
  }

  function toggleCompletion() {
    if (state.selectedId === "root") return;
    if (elements.complete.checked) state.completed.add(state.selectedId);
    else state.completed.delete(state.selectedId);
    saveProgress();
    render();
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (error) {
      setTimeout(function () { showToast("无法读取本地学习进度，页面仍可正常浏览。", true); }, 0);
      return new Set();
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(state.completed)));
    } catch (error) {
      showToast("浏览器未允许本地保存，请使用导出进度备份。", true);
    }
  }

  function exportProgress() {
    const payload = {
      schema: "control-roadmap-progress-v1",
      version: "V1.0.3",
      exportedAt: new Date().toISOString(),
      completed: Array.from(state.completed)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "控制方向学习进度_" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("学习进度已导出。", false);
  }

  function importProgress(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const payload = JSON.parse(String(reader.result));
        if (!payload || payload.schema !== "control-roadmap-progress-v1" || !Array.isArray(payload.completed)) throw new Error("schema");
        const valid = payload.completed.filter(function (id) { return state.nodesById.has(id) && id !== "root"; });
        state.completed = new Set(valid);
        saveProgress();
        render();
        showToast("已导入 " + valid.length + " 个完成节点。", false);
      } catch (error) {
        showToast("导入失败：文件不是本学习树导出的有效进度。", true);
      }
    };
    reader.onerror = function () { showToast("导入失败：无法读取文件。", true); };
    reader.readAsText(file, "utf-8");
  }

  function clearProgress() {
    if (!state.completed.size) {
      showToast("当前没有已完成节点。", false);
      return;
    }
    if (!window.confirm("确定清空当前浏览器中的全部学习进度吗？此操作不会修改原始文档。")) return;
    state.completed.clear();
    saveProgress();
    render();
    showToast("学习进度已清空。", false);
  }

  function searchMatches() {
    if (!state.query) return [];
    const normalizedQuery = state.query.toLocaleLowerCase("zh-CN").trim();
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    return state.flat.filter(function (node) {
      if (state.scope !== "all" && node.id !== "root" && !belongsToScope(node.id, state.scope)) return false;
      const haystack = searchableText(node);
      return tokens.every(function (token) { return haystack.includes(token); });
    }).sort(function (a, b) {
      const rankDifference = searchTitleRank(b, normalizedQuery) - searchTitleRank(a, normalizedQuery);
      return rankDifference || a.title.localeCompare(b.title, "zh-CN");
    }).slice(0, 60);
  }

  function searchTitleRank(node, query) {
    const title = node.title.toLocaleLowerCase("zh-CN");
    if (title === query) return 4;
    if (title.startsWith(query)) return 3;
    const titleTokens = title.split(/[\s/|,，、()（）]+/).filter(Boolean);
    if (titleTokens.includes(query)) return 2;
    if (title.includes(query)) return 1;
    return 0;
  }

  function searchableText(node) {
    const templateText = (codeTemplates[node.id] || []).flatMap(function (entry) {
      return [entry.title, entry.summary, entry.reusable, entry.adapt].concat(entry.explanation || []);
    });
    const values = [node.title, node.type, node.summary, node.level, node.duration]
      .concat(node.prerequisites || [], node.knowledge || [], node.algorithms || [], node.tasks || [], node.acceptance || [], node.pitfalls || [], node.symptoms || []);
    values.push.apply(values, templateText);
    return values.join(" ").toLocaleLowerCase("zh-CN");
  }

  function renderSearchResults() {
    if (!state.query) {
      elements.searchResults.hidden = true;
      return;
    }
    const matches = searchMatches();
    elements.searchResults.innerHTML = matches.length ? matches.map(function (node) {
      return "<button class=\"search-result\" type=\"button\" role=\"option\" data-search-id=\"" + escapeAttr(node.id) + "\"><span><strong>" + highlight(node.title, state.query) + "</strong><small>" + escapeHtml(node.path.slice(0, -1).join(" / ")) + "</small></span><span class=\"result-type\">" + escapeHtml(node.type) + "</span></button>";
    }).join("") : "<div class=\"search-empty\">没有匹配节点。尝试更短的关键词。</div>";
    elements.searchResults.hidden = false;
    elements.searchResults.querySelectorAll("[data-search-id]").forEach(function (button) {
      button.addEventListener("click", function () {
        elements.searchResults.hidden = true;
        selectNode(button.dataset.searchId, true);
      });
    });
  }

  function belongsToScope(id, scopeId) {
    if (id === scopeId) return true;
    return getAncestors(id).includes(scopeId);
  }

  function expandAll() {
    state.flat.forEach(function (node) {
      if (node.children && node.children.length && (state.scope === "all" || node.id === "root" || belongsToScope(node.id, state.scope))) state.expanded.add(node.id);
    });
    render();
    requestAnimationFrame(fitView);
  }

  function collapseAll() {
    state.expanded = new Set(["root"]);
    if (state.scope !== "all") state.expanded.add(state.scope);
    render();
    requestAnimationFrame(fitView);
  }

  function resetFilters() {
    state.scope = "all";
    state.query = "";
    elements.scope.value = "all";
    elements.search.value = "";
    elements.clearSearch.hidden = true;
    elements.searchResults.hidden = true;
    state.expanded.add("root");
    render();
    requestAnimationFrame(fitView);
  }

  function getAncestors(id) {
    const result = [];
    let current = state.parents.get(id);
    while (current) {
      result.unshift(current);
      current = state.parents.get(current);
    }
    return result;
  }

  function isOnSelectedPath(parentId, childId) {
    if (state.selectedId === childId && state.parents.get(childId) === parentId) return true;
    const ancestors = getAncestors(state.selectedId);
    const parentIndex = ancestors.indexOf(parentId);
    return parentIndex >= 0 && ancestors[parentIndex + 1] === childId;
  }

  function fitView() {
    const rect = elements.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !state.worldSize.width || !state.worldSize.height) return;
    const margin = 26;
    const scale = clamp(Math.min((rect.width - margin * 2) / state.worldSize.width, (rect.height - margin * 2) / state.worldSize.height), .22, 1.2);
    state.transform.scale = scale;
    state.transform.x = (rect.width - state.worldSize.width * scale) / 2;
    state.transform.y = (rect.height - state.worldSize.height * scale) / 2;
    applyTransform();
  }

  function centerNode(id) {
    const position = state.layout.get(id);
    if (!position) return;
    const rect = elements.canvas.getBoundingClientRect();
    const scale = Math.max(state.transform.scale, .72);
    state.transform.scale = clamp(scale, .22, 1.8);
    state.transform.x = rect.width / 2 - (position.x + NODE_W / 2) * state.transform.scale;
    state.transform.y = rect.height / 2 - (position.y + NODE_H / 2) * state.transform.scale;
    applyTransform();
  }

  function zoomAt(factor, clientX, clientY) {
    const rect = elements.canvas.getBoundingClientRect();
    const px = clientX == null ? rect.width / 2 : clientX - rect.left;
    const py = clientY == null ? rect.height / 2 : clientY - rect.top;
    const old = state.transform.scale;
    const next = clamp(old * factor, .22, 1.8);
    const worldX = (px - state.transform.x) / old;
    const worldY = (py - state.transform.y) / old;
    state.transform.scale = next;
    state.transform.x = px - worldX * next;
    state.transform.y = py - worldY * next;
    applyTransform();
  }

  function onWheel(event) {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.1 : .9, event.clientX, event.clientY);
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.target.closest(".tree-node") || event.target.closest("button")) return;
    state.dragging = true;
    state.dragOrigin = { x: event.clientX, y: event.clientY, tx: state.transform.x, ty: state.transform.y };
    elements.canvas.classList.add("dragging");
    elements.canvas.setPointerCapture && elements.canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!state.dragging || !state.dragOrigin) return;
    state.transform.x = state.dragOrigin.tx + event.clientX - state.dragOrigin.x;
    state.transform.y = state.dragOrigin.ty + event.clientY - state.dragOrigin.y;
    applyTransform();
  }

  function onPointerUp() {
    state.dragging = false;
    state.dragOrigin = null;
    elements.canvas.classList.remove("dragging");
  }

  function applyTransform() {
    elements.world.style.transform = "translate(" + state.transform.x + "px," + state.transform.y + "px) scale(" + state.transform.scale + ")";
    elements.zoomLabel.textContent = Math.round(state.transform.scale * 100) + "%";
  }

  function openDrawer(kind) {
    closeDrawers();
    if (kind === "nav") elements.navigator.classList.add("open");
    if (kind === "detail") elements.details.classList.add("open");
    elements.backdrop.hidden = false;
  }

  function closeDrawers() {
    elements.navigator.classList.remove("open");
    elements.details.classList.remove("open");
    elements.backdrop.hidden = true;
  }

  function showToast(message, isError) {
    if (!elements.toast) return;
    const toast = document.createElement("div");
    toast.className = "toast" + (isError ? " error" : "");
    toast.textContent = message;
    elements.toast.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 3400);
  }

  function highlight(text, query) {
    const safe = escapeHtml(text || "");
    if (!query) return safe;
    const token = query.trim().split(/\s+/)[0];
    if (!token) return safe;
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safe.replace(new RegExp("(" + escapedToken + ")", "ig"), "<mark>$1</mark>");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char];
    });
  }

  function escapeAttr(value) { return escapeHtml(value); }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function debounce(fn, wait) {
    let timer;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }
})();
