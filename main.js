const { Plugin, TFile, normalizePath } = require("obsidian");
const { StateField, RangeSetBuilder } = require("@codemirror/state");
const { Decoration, EditorView, WidgetType } = require("@codemirror/view");

const DEFAULT_HEIGHT = "760px";
const DEFAULT_MODE = "inline";
const HEIGHT_STEP = 80;
const MIN_HEIGHT = 260;
const MAX_HEIGHT = 2400;

function parseOptions(source) {
  const options = {
    path: "",
    height: DEFAULT_HEIGHT,
    title: "",
    mode: DEFAULT_MODE,
    controls: "true",
    minHeight: String(MIN_HEIGHT),
    maxHeight: String(MAX_HEIGHT),
    step: String(HEIGHT_STEP),
    explicit: {}
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1 && !options.path) {
      options.path = line;
      continue;
    }
    if (equals === -1) continue;

    const rawKey = line.slice(0, equals).trim();
    const key = rawKey === "src" || rawKey === "file" ? "path" : rawKey;
    const value = line.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
    if (key in options) {
      options[key] = value;
      options.explicit[key] = true;
    }
  }

  return options;
}

function resolveVaultPath(rawPath, sourcePath) {
  const cleaned = rawPath.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return "";

  if (cleaned.startsWith("/")) {
    return normalizeVaultPath(cleaned.slice(1));
  }

  const sourceDir = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
  return normalizeVaultPath(sourceDir ? `${sourceDir}/${cleaned}` : cleaned);
}

function normalizeVaultPath(path) {
  const normalized = normalizePath(path.replace(/\\/g, "/"));
  const parts = [];

  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/");
}

function getPathCandidates(rawPath, sourcePath) {
  const cleaned = rawPath.trim().replace(/^["']|["']$/g, "");
  const candidates = [];

  const addCandidate = path => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  addCandidate(resolveVaultPath(cleaned, sourcePath));

  if (cleaned && !cleaned.startsWith("/") && !cleaned.startsWith(".") && !cleaned.includes("://")) {
    addCandidate(normalizeVaultPath(cleaned));
  }

  return candidates;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getResourceBase(resourcePath) {
  const cleanPath = resourcePath.split("?")[0].split("#")[0];
  const slash = cleanPath.lastIndexOf("/");
  return slash === -1 ? "" : `${cleanPath.slice(0, slash + 1)}`;
}

function buildFrameGuard() {
  return `<script>
(() => {
  const noop = () => undefined;
  window.alert = noop;
  window.confirm = () => false;
  window.prompt = () => null;
  window.onerror = () => true;
  window.addEventListener("error", event => event.preventDefault(), true);
  window.addEventListener("unhandledrejection", event => event.preventDefault(), true);
})();
</script>`;
}

function prepareInlineHtml(html, resourcePath) {
  const baseHref = getResourceBase(resourcePath);
  const insert = `${baseHref ? `<base href="${escapeHtml(baseHref)}">` : ""}${buildFrameGuard()}`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, match => `${match}\n${insert}`);
  }

  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, match => `${match}\n<head>${insert}</head>`);
  }

  return `<!doctype html><html><head>${insert}</head><body>${html}</body></html>`;
}

function parseHeightPixels(height) {
  const match = String(height || DEFAULT_HEIGHT).trim().match(/^(\d+)(?:px)?$/);
  if (!match) return null;
  return Number(match[1]);
}

function clampHeight(height) {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
}

function optionInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionBool(value) {
  return !["false", "0", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function parseLinkOptions(text) {
  const options = [];
  const parts = String(text || "")
    .replace(/^html-card\b/i, "")
    .trim()
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (/^\d+(?:px)?$/i.test(part)) {
      options.push(`height=${part}`);
      continue;
    }

    if (/^(height|minHeight|maxHeight|step|controls|mode|title)=/i.test(part)) {
      options.push(part);
    }
  }

  return options.join("\n");
}

function hrefLooksLikeHtml(href) {
  const path = String(href || "").split("#")[0].split("?")[0];
  return /\.html?$/i.test(path);
}

function sourceFromHtmlCardLink(link) {
  const href = link.getAttribute("href") || "";
  const text = link.textContent || "";

  if (!/^html-card\b/i.test(text.trim())) return "";
  if (!hrefLooksLikeHtml(href)) return "";

  const options = parseLinkOptions(text);
  return [`src=${href}`, options].filter(Boolean).join("\n");
}

function unescapeMarkdownPath(path) {
  return String(path || "")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/\\([\\()[\]])/g, "$1");
}

function htmlCardSourceFromLine(lineText) {
  const text = String(lineText || "").trim();
  const match = text.match(/^\[([^\]]+)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
  if (!match) return "";

  const label = match[1].trim();
  const href = unescapeMarkdownPath(match[2]);
  if (!/^html-card\b/i.test(label)) return "";
  if (!hrefLooksLikeHtml(href)) return "";

  const options = parseLinkOptions(label);
  return [`src=${href}`, options].filter(Boolean).join("\n");
}

class LocalHtmlCardWidget extends WidgetType {
  constructor(plugin, source, sourcePath, from) {
    super();
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath || "";
    this.from = from;
  }

  eq(other) {
    return other instanceof LocalHtmlCardWidget &&
      other.plugin === this.plugin &&
      other.source === this.source &&
      other.sourcePath === this.sourcePath &&
      other.from === this.from;
  }

  toDOM(view) {
    const wrapper = document.createElement("div");
    wrapper.className = "local-html-card-live-preview";
    wrapper.setAttribute("contenteditable", "false");
    const editButton = wrapper.createDiv({ cls: "local-html-card-edit-source" });
    editButton.textContent = "Edit source";
    editButton.setAttribute("role", "button");
    editButton.setAttribute("tabindex", "0");
    editButton.setAttribute("title", "Show the original Markdown link");

    const revealSource = event => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.from },
        scrollIntoView: true
      });
      view.focus();
    };

    editButton.addEventListener("mousedown", revealSource);
    editButton.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        revealSource(event);
      }
    });

    const card = wrapper.createDiv();
    this.plugin.safeRenderLocalHtml(this.source, card, {
      sourcePath: this.sourcePath
    }).catch(error => console.error("local-html-card live preview render failed", error));
    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

function buildLivePreviewDecorations(plugin, state) {
  const builder = new RangeSetBuilder();
  const activeFile = plugin.app.workspace.getActiveFile();
  const sourcePath = activeFile ? activeFile.path : "";
  const selectionLineNumbers = new Set(state.selection.ranges.map(range => state.doc.lineAt(range.head).number));

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo);
    const source = htmlCardSourceFromLine(line.text);
    if (!source) continue;
    if (selectionLineNumbers.has(lineNo)) continue;

    builder.add(line.from, line.to, Decoration.replace({
      widget: new LocalHtmlCardWidget(plugin, source, sourcePath, line.from),
      block: true
    }));
  }

  return builder.finish();
}

function createLivePreviewExtension(plugin) {
  return StateField.define({
    create(state) {
      return buildLivePreviewDecorations(plugin, state);
    },
    update(decorations, transaction) {
      if (transaction.docChanged || transaction.selection) {
        return buildLivePreviewDecorations(plugin, transaction.state);
      }
      return decorations.map(transaction.changes);
    },
    provide(field) {
      return EditorView.decorations.from(field);
    }
  });
}

module.exports = class LocalHtmlCardPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ heights: {} }, await this.loadData());

    this.registerEditorExtension(createLivePreviewExtension(this));

    this.registerMarkdownCodeBlockProcessor("local-html-card", async (source, el, ctx) => {
      await this.safeRenderLocalHtml(source, el, ctx);
    });

    this.registerMarkdownCodeBlockProcessor("ds-animation", async (source, el, ctx) => {
      await this.safeRenderLocalHtml(source, el, ctx);
    });

    this.registerMarkdownPostProcessor(async (el, ctx) => {
      await this.processHtmlCardLinks(el, ctx);
    }, 100);

    this.registerDomEvent(window, "message", async (event) => {
      const data = event.data;
      if (!data || data.type !== "local-html-card-open" || typeof data.file !== "string") return;
      const frames = Array.from(document.querySelectorAll(".local-html-card iframe"));
      if (!frames.some(frame => frame.contentWindow === event.source)) return;
      const file = this.app.metadataCache.getFirstLinkpathDest(data.file, "");
      if (!file) return;
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      if (typeof data.heading === "string" && data.heading.trim()) {
        leaf.setEphemeralState({ subpath: "#" + data.heading.trim() });
      }
    });
  }

  async processHtmlCardLinks(el, ctx) {
    const links = Array.from(el.querySelectorAll("a[href]"))
      .filter(link => !link.closest(".local-html-card"));

    for (const link of links) {
      const source = sourceFromHtmlCardLink(link);
      if (!source) continue;

      const wrapper = document.createElement("div");
      link.replaceWith(wrapper);
      await this.safeRenderLocalHtml(source, wrapper, ctx);
    }
  }

  async safeRenderLocalHtml(source, el, ctx) {
    try {
      await this.renderLocalHtml(source, el, ctx);
    } catch (error) {
      el.empty();
      el.addClass("local-html-card");
      el.createEl("div", {
        cls: "local-html-card-error",
        text: `local-html-card: ${error.message || String(error)}`
      });
      console.error("local-html-card render failed", error);
    }
  }

  async renderLocalHtml(source, el, ctx) {
      const options = parseOptions(source);
      const pathCandidates = getPathCandidates(options.path, ctx.sourcePath || "");
      let vaultPath = "";
      const renderId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      el.dataset.localHtmlCardRenderId = renderId;

      el.empty();
      el.addClass("local-html-card");

      if (!pathCandidates.length) {
        el.createEl("div", {
          cls: "local-html-card-error",
          text: "local-html-card: missing path"
        });
        return;
      }

      let file = null;
      for (const candidate of pathCandidates) {
        const abstractFile = this.app.vault.getAbstractFileByPath(candidate);
        if (abstractFile instanceof TFile) {
          file = abstractFile;
          vaultPath = candidate;
          break;
        }
      }

      if (!(file instanceof TFile)) {
        el.createEl("div", {
          cls: "local-html-card-error",
          text: `local-html-card: file not found: ${pathCandidates.join(" | ")}`
        });
        return;
      }

      const heightKey = `${ctx.sourcePath || ""}::${vaultPath}`;
      const savedHeight = this.settings.heights[heightKey];
      const initialHeight = options.explicit.height ? options.height : (savedHeight || options.height);
      const initialHeightPixels = parseHeightPixels(initialHeight);
      const minHeight = optionInt(options.minHeight, MIN_HEIGHT);
      const maxHeight = optionInt(options.maxHeight, MAX_HEIGHT);
      const heightStep = optionInt(options.step, HEIGHT_STEP);
      const showControls = optionBool(options.controls);

      let decreaseButton = null;
      let heightInput = null;
      let increaseButton = null;
      let reloadButton = null;
      if (showControls) {
        const controls = el.createEl("div", { cls: "local-html-card-controls" });
        decreaseButton = controls.createEl("button", {
          cls: "local-html-card-button",
          text: "-",
          attr: { type: "button", title: "Decrease height", "aria-label": "Decrease height" }
        });
        heightInput = controls.createEl("input", {
          cls: "local-html-card-height",
          attr: {
            type: "number",
            min: String(minHeight),
            max: String(maxHeight),
            step: String(heightStep),
            title: "Frame height",
            "aria-label": "Frame height"
          }
        });
        increaseButton = controls.createEl("button", {
          cls: "local-html-card-button",
          text: "+",
          attr: { type: "button", title: "Increase height", "aria-label": "Increase height" }
        });
        reloadButton = controls.createEl("button", {
          cls: "local-html-card-button",
          text: "R",
          attr: { type: "button", title: "Reload frame", "aria-label": "Reload frame" }
        });
      }

      const iframe = el.createEl("iframe", {
        cls: "local-html-card-frame",
        attr: {
          title: options.title || file.basename,
          sandbox: "allow-scripts",
          referrerpolicy: "no-referrer"
        }
      });
      const clampBlockHeight = height => Math.max(minHeight, Math.min(maxHeight, height));
      iframe.style.height = initialHeightPixels == null ? initialHeight : `${clampBlockHeight(initialHeightPixels)}px`;
      if (heightInput) heightInput.value = String(parseHeightPixels(iframe.style.height) || parseHeightPixels(DEFAULT_HEIGHT));

      const resourcePath = this.app.vault.getResourcePath(file);

      const persistHeight = height => {
        this.settings.heights[heightKey] = `${height}px`;
        this.saveData(this.settings).catch(error => console.error("local-html-card save failed", error));
      };

      const setHeight = height => {
        const nextHeight = clampBlockHeight(height);
        iframe.style.height = `${nextHeight}px`;
        if (heightInput) heightInput.value = String(nextHeight);
        persistHeight(nextHeight);
      };

      const setResourceSource = () => {
        iframe.removeAttribute("srcdoc");
        iframe.src = resourcePath;
      };

      const setInlineSource = async () => {
        const html = await this.app.vault.read(file);
        if (!el.isConnected || el.dataset.localHtmlCardRenderId !== renderId) return;
        iframe.removeAttribute("src");
        iframe.srcdoc = prepareInlineHtml(html, resourcePath);
      };

      const loadFrame = async () => {
        if (options.mode === "resource") {
          iframe.addEventListener("error", () => {
            setInlineSource().catch(error => console.error("local-html-card inline fallback failed", error));
          }, { once: true });
          setResourceSource();
        } else {
          await setInlineSource();
        }
      };

      if (showControls) {
        decreaseButton.addEventListener("click", () => {
          setHeight((parseHeightPixels(iframe.style.height) || parseHeightPixels(DEFAULT_HEIGHT)) - heightStep);
        });

        increaseButton.addEventListener("click", () => {
          setHeight((parseHeightPixels(iframe.style.height) || parseHeightPixels(DEFAULT_HEIGHT)) + heightStep);
        });

        heightInput.addEventListener("change", () => {
          setHeight(Number(heightInput.value) || parseHeightPixels(DEFAULT_HEIGHT));
        });

        reloadButton.addEventListener("click", () => {
          iframe.removeAttribute("src");
          iframe.removeAttribute("srcdoc");
          loadFrame().catch(error => console.error("local-html-card reload failed", error));
        });
      }

      await loadFrame();
  }
};
