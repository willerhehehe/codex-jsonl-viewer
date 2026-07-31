(function registerClaudeViewer(global) {
  const encode = encodeURIComponent;

  function sessionParams(state) {
    return new URLSearchParams({
      project: state.selectedProject,
      file: state.selectedFile,
    });
  }

  function valueText(value) {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(valueText).filter(Boolean).join(" ");
    }
    if (value && typeof value === "object") {
      return valueText(value.text ?? value.thinking ?? value.content ?? value.message ?? JSON.stringify(value));
    }
    return value === undefined || value === null ? "" : String(value);
  }

  function projectedSummary(blocks, phase) {
    if (phase === "reasoning") {
      return blocks.map((block) => valueText(block.thinking)).filter(Boolean).join(" ");
    }
    if (phase === "assistant") {
      return blocks.map((block) => valueText(block.text)).filter(Boolean).join(" ");
    }
    return blocks.map((block) => {
      if (["tool_use", "server_tool_use"].includes(block.type)) {
        return `${block.name || block.type} ${valueText(block.input)}`.trim();
      }
      return valueText(block.content) || block.type;
    }).filter(Boolean).join(" ");
  }

  function projectPhaseItem(item, phase) {
    if (phase === "input") {
      return item;
    }
    const allowed = {
      reasoning: new Set(["thinking"]),
      tools: new Set(["tool_use", "server_tool_use", "tool_result", "advisor_tool_result"]),
      assistant: new Set(["text"]),
    }[phase];
    const content = item?.record?.message?.content;
    if (!allowed || !Array.isArray(content)) {
      return item;
    }
    const blocks = content.filter((block) => allowed.has(block?.type));
    if (!blocks.length) {
      return item;
    }
    const record = {
      ...item.record,
      message: { ...item.record.message, content: blocks },
    };
    const toolUses = blocks.filter((block) => ["tool_use", "server_tool_use"].includes(block.type));
    const toolResults = blocks.filter((block) => ["tool_result", "advisor_tool_result"].includes(block.type));
    const phaseKind = phase === "tools"
      ? (toolUses.length ? "tool-use" : "tool-result")
      : phase === "assistant" ? "assistant-text" : "thinking";
    const phaseLabel = phase === "tools"
      ? (toolUses.length ? `Tool call · ${toolUses.map((block) => block.name || block.type).join(", ")}` : "Tool result")
      : phase === "assistant" ? "Assistant output" : "Thinking";
    return {
      ...item,
      record,
      rawLine: JSON.stringify(record, null, 2),
      viewer: {
        ...item.viewer,
        categories: [phase],
        kind: phaseKind,
        label: phaseLabel,
        summary: projectedSummary(blocks, phase),
        toolCount: toolUses.length,
        toolResultCount: toolResults.length,
        toolNames: toolUses.map((block) => block.name || block.type),
      },
    };
  }

  const viewer = {
    key: "claude",
    label: "Claude",
    projectsPath: "/api/claude/projects",
    sessionsPath(project) {
      return `/api/claude/sessions?project=${encode(project)}`;
    },
    initialPaths(state, limit) {
      const params = sessionParams(state);
      params.set("limit", String(limit));
      const query = params.toString();
      return [`/api/claude/initial?${query}`, `/api/claude/turns?${query}`];
    },
    turnsPath(state) {
      return `/api/claude/turns?${sessionParams(state).toString()}`;
    },
    turnEventsPath(state, turn) {
      const params = sessionParams(state);
      params.set("start", String(turn.startOffset));
      params.set("end", String(turn.endOffset));
      return `/api/claude/turn-events?${params.toString()}`;
    },
    streamPath(state) {
      const params = sessionParams(state);
      params.set("offset", String(state.offset));
      return `/api/claude/stream?${params.toString()}`;
    },
    fileTitle(file) {
      return file.title || file.firstPrompt || `Session ${viewer.fileId(file.name)}`;
    },
    fileId(fileName) {
      return String(fileName || "").replace(/\.jsonl$/, "").slice(0, 8);
    },
    activeFileLabel(file) {
      return `${viewer.fileTitle(file)} · ${viewer.fileId(file.name)}`;
    },
    categories(item) {
      return Array.isArray(item?.viewer?.categories) ? item.viewer.categories : [];
    },
    primaryCategory(item) {
      return item?.viewer?.category || viewer.categories(item)[0] || null;
    },
    describeEvent(item) {
      if (!item?.viewer) {
        return null;
      }
      const detailKind = item.viewer.kind || "context";
      const kind = detailKind === "user-prompt" || detailKind === "assistant-text"
        ? "messages"
        : detailKind === "tool-use" || detailKind === "tool-result"
          ? "tools"
          : detailKind === "invalid-json" || detailKind === "api_error"
            ? "errors"
            : "context";
      return {
        kind,
        label: item.viewer.label || "Claude event",
        summary: item.viewer.summary || "No summary",
      };
    },
    isTurnBoundary(item) {
      return Boolean(item?.viewer?.boundary || item?.viewer?.turnComplete);
    },
    projectPhaseItem,
  };

  global.ClaudeSessionViewer = Object.freeze(viewer);
}(window));
