import fs from 'node:fs';
const src = fs.readFileSync('prototype/index.html', 'utf8');
const lines = src.split('\n');
const beforeIdx = 2743;
const afterIdx = 3007;

const newBlock = `
      // ----------------------------------------------------------------
      // Dependency tree — tidy horizontal node-link (Redux-DevTools style).
      //
      // Every directory and every file is a node. Edges are containment
      // (parent → child) today; import edges arrive with web-tree-sitter
      // extractors in v0.2. The layout is a hand-rolled tidy tree:
      //   • x = depth × COL_WIDTH
      //   • y = leaf-index × ROW_HEIGHT for leaves; mean of children for parents
      // Curved cubic Bézier edges; collapsible folder nodes; hover lights
      // up the full ancestor chain + descendant subtree, everything else
      // fades. Click a file to open the Files pane; click a folder to
      // collapse / expand.
      // ----------------------------------------------------------------
      const COLLAPSED = new Set();        // folder paths currently collapsed
      function renderGraph() {
        const p = $('#panel-graph');
        p.innerHTML = '';

        // Header
        p.append(h('h1', { class: 'text-xl font-semibold tracking-tight mb-1' }, 'Dependency tree'));
        p.append(h('p', { class: 'text-sm text-[var(--fg-muted)] mb-5 max-w-2xl leading-relaxed' },
          'Every directory and file, connected by containment. Click a folder to collapse or expand; click a file to open it. Import edges arrive with the v0.2 extractor pass.'));

        // ---- Build the tidy-tree data ----
        // Seed: we get DATA.tree (from human artifact) — a node with
        // { name, path, kind, children } already. If missing, fall back to
        // building from DATA.files. Here we use the hierarchy directly.
        const root = DATA?.tree || { id: '.', name: DATA?.project?.name || 'root', path: '.', kind: 'directory', children: [] };

        // Default expansion policy: root + its direct children expanded,
        // deeper folders collapsed. Stored in COLLAPSED so toggles persist
        // across re-renders.
        (function seedCollapsed(n, depth) {
          if (n.kind === 'directory' && n.children) {
            if (depth >= 2 && !COLLAPSED.has(n.path) && !COLLAPSED.has('__EXPAND__:' + n.path)) {
              COLLAPSED.add(n.path);
            }
            for (const c of n.children) seedCollapsed(c, depth + 1);
          }
        })(root, 0);

        // ---- Layout ----
        const COL_W = 176;                 // horizontal distance between depth levels
        const ROW_H = 22;                  // vertical distance between leaf rows
        const PAD_X = 40;
        const PAD_Y = 24;

        let leafIdx = 0;
        const placed = [];                 // flat list of {node, x, y, depth, parentId, visible}

        function layout(node, depth) {
          const id = node.path || node.id || node.name;
          const collapsed = node.kind === 'directory' && COLLAPSED.has(node.path || node.id || '');
          const kids = (node.kind === 'directory' && !collapsed && node.children) ? node.children : [];
          if (kids.length) {
            const placedKids = kids.map((c) => layout(c, depth + 1));
            const firstY = placedKids[0].y;
            const lastY = placedKids[placedKids.length - 1].y;
            const entry = {
              id, node, depth, x: PAD_X + depth * COL_W, y: (firstY + lastY) / 2,
              collapsed, isLeaf: false,
            };
            placed.push(entry);
            // attach child ids for edge drawing
            entry.childIds = placedKids.map((k) => k.id);
            return entry;
          }
          // Leaf
          const entry = {
            id, node, depth, x: PAD_X + depth * COL_W, y: PAD_Y + leafIdx * ROW_H,
            collapsed: false, isLeaf: (node.kind === 'file') || collapsed,
          };
          if (node.kind === 'directory' && collapsed) entry.collapsed = true;
          placed.push(entry);
          leafIdx++;
          return entry;
        }
        const rootEntry = layout(root, 0);

        const byId = new Map(placed.map((e) => [e.id, e]));
        // Parent lookup
        function attachParents() {
          (function walk(node, parentId) {
            const id = node.path || node.id || node.name;
            const e = byId.get(id);
            if (e) e.parentId = parentId;
            const collapsed = node.kind === 'directory' && COLLAPSED.has(node.path || node.id || '');
            const kids = (node.kind === 'directory' && !collapsed && node.children) ? node.children : [];
            for (const c of kids) walk(c, id);
          })(root, null);
        }
        attachParents();

        const width  = Math.max(...placed.map((e) => e.x)) + COL_W + PAD_X + 40;
        const height = Math.max(PAD_Y + leafIdx * ROW_H + PAD_Y, 400);

        // ---- Render SVG ----
        const svgParts = [];
        svgParts.push(`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet" class="dep-tree" style="display:block;min-width:100%;" role="img" aria-label="Dependency tree">`);

        // Edges — smooth cubic from parent (x+node radius) to child (x-node radius)
        svgParts.push('<g class="dep-edges">');
        for (const e of placed) {
          if (!e.childIds) continue;
          const px = e.x + 6, py = e.y;
          for (const cid of e.childIds) {
            const c = byId.get(cid); if (!c) continue;
            const cx = c.x - 8, cy = c.y;
            const mx = (px + cx) / 2;
            svgParts.push(`<path data-from="${escapeHtml(e.id)}" data-to="${escapeHtml(cid)}" d="M ${px} ${py} C ${mx} ${py}, ${mx} ${cy}, ${cx} ${cy}"/>`);
          }
        }
        svgParts.push('</g>');

        // Nodes
        svgParts.push('<g class="dep-nodes">');
        for (const e of placed) {
          const n = e.node;
          const isDir = n.kind === 'directory';
          const isRoot = e.depth === 0;
          const tokStr = n.tokenCost ? ` · ${fmtTok(n.tokenCost)} tok` : '';
          const kidCount = isDir && n.children ? n.children.length : 0;
          const status = n.status || 'ok';
          const statusColor = status === 'broken' ? 'var(--danger)' : status === 'stale' ? 'var(--warn)' : isDir ? 'var(--info)' : 'var(--accent)';
          const r = isRoot ? 7 : isDir ? 5 : 3.5;
          const fillOp = e.collapsed ? 1 : (isDir ? 0.25 : 0.9);
          const strokeOp = 1;
          const label = isDir ? `${escapeHtml(n.name)}${e.collapsed && kidCount ? `   +${kidCount}` : ''}` : escapeHtml(n.name);
          const meta  = isRoot ? `${n.children?.length ?? 0} top-level${tokStr}`
                     : isDir  ? `${kidCount} item${kidCount === 1 ? '' : 's'}${tokStr}`
                              : tokStr.replace(/^ · /, '');

          svgParts.push(`<g class="dep-node" data-id="${escapeHtml(e.id)}" data-path="${escapeHtml(n.path || '')}" data-kind="${isDir ? 'directory' : 'file'}" data-depth="${e.depth}" transform="translate(${e.x}, ${e.y})" tabindex="0" role="button" aria-label="${escapeHtml(n.name)}">
            <circle class="dep-circle" r="${r}" fill="${statusColor}" fill-opacity="${fillOp}" stroke="${statusColor}" stroke-width="1.5" stroke-opacity="${strokeOp}"/>
            ${e.collapsed ? `<circle r="${r - 2}" fill="var(--bg)" fill-opacity="0"/><text x="0" y="0.5" text-anchor="middle" dominant-baseline="middle" font-family="JetBrains Mono, monospace" font-size="8" font-weight="700" fill="var(--bg)">+</text>` : ''}
            <text x="${r + 6}" y="4" font-family="${isRoot ? 'Fraunces, serif' : 'Urbanist, system-ui, sans-serif'}" font-size="${isRoot ? 14 : isDir ? 12 : 11.5}" font-weight="${isRoot ? 600 : isDir ? 600 : 500}" fill="var(--fg)" letter-spacing="-0.01em">${label}</text>
            ${meta ? `<text x="${r + 6}" y="16" font-family="JetBrains Mono, monospace" font-size="9.5" fill="var(--fg-subtle)">${escapeHtml(meta)}</text>` : ''}
          </g>`);
        }
        svgParts.push('</g></svg>');

        // Wrap in a scrollable surface (no glass — keep text crisp)
        const wrap = h('div', {
          class: 'dep-wrap rounded-xl overflow-auto',
          style: {
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-sm)',
            padding: '8px',
            maxHeight: '72dvh',
          },
        });
        wrap.innerHTML = svgParts.join('');
        p.append(wrap);

        // Legend
        const legend = h('div', { class: 'mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[var(--fg-muted)]' });
        legend.innerHTML = `
          <span class="inline-flex items-center gap-2"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="color-mix(in oklab, var(--info) 25%, transparent)" stroke="var(--info)" stroke-width="1.5"/></svg><strong>Folder</strong> · click to collapse</span>
          <span class="inline-flex items-center gap-2"><svg width="12" height="12"><circle cx="6" cy="6" r="3.5" fill="var(--accent)" stroke="var(--accent)"/></svg><strong>File · ok</strong></span>
          <span class="inline-flex items-center gap-2"><svg width="12" height="12"><circle cx="6" cy="6" r="3.5" fill="var(--warn)" stroke="var(--warn)"/></svg><strong>stale</strong></span>
          <span class="inline-flex items-center gap-2"><svg width="12" height="12"><circle cx="6" cy="6" r="3.5" fill="var(--danger)" stroke="var(--danger)"/></svg><strong>broken</strong></span>
          <span class="ml-auto">Edges = containment · v0.2 overlays import edges</span>
        `;
        p.append(legend);

        // ---- Interactivity: hover highlights ancestors + descendants ----
        const svgEl = wrap.querySelector('svg');
        const allNodeGroups = svgEl.querySelectorAll('.dep-node');
        const allEdges = svgEl.querySelectorAll('.dep-edges path');

        function highlight(id) {
          if (!id) { svgEl.classList.remove('dep-hl'); allNodeGroups.forEach((g) => g.classList.remove('hl','fade')); allEdges.forEach((e) => e.classList.remove('hl','fade')); return; }
          svgEl.classList.add('dep-hl');
          // Compute ancestors + descendants
          const hlSet = new Set([id]);
          let cur = byId.get(id);
          while (cur && cur.parentId) { hlSet.add(cur.parentId); cur = byId.get(cur.parentId); }
          (function addDesc(node) {
            const e = byId.get(node.path || node.id || node.name);
            if (!e) return;
            const n = e.node;
            if (n.kind === 'directory' && !e.collapsed && n.children) {
              for (const c of n.children) { hlSet.add(c.path || c.id || c.name); addDesc(c); }
            }
          })(byId.get(id).node);
          allNodeGroups.forEach((g) => {
            const gid = g.getAttribute('data-id');
            g.classList.toggle('hl', hlSet.has(gid));
            g.classList.toggle('fade', !hlSet.has(gid));
          });
          allEdges.forEach((e) => {
            const f = e.getAttribute('data-from'); const t = e.getAttribute('data-to');
            const lit = hlSet.has(f) && hlSet.has(t);
            e.classList.toggle('hl', lit);
            e.classList.toggle('fade', !lit);
          });
        }

        svgEl.addEventListener('mousemove', (ev) => {
          const g = ev.target.closest('.dep-node');
          highlight(g?.getAttribute('data-id'));
        });
        svgEl.addEventListener('mouseleave', () => highlight(null));

        // ---- Click: toggle folder / open file ----
        svgEl.addEventListener('click', (ev) => {
          const g = ev.target.closest('.dep-node'); if (!g) return;
          const kind = g.getAttribute('data-kind');
          const id = g.getAttribute('data-id');
          const path = g.getAttribute('data-path');
          if (kind === 'directory') {
            const key = id;
            if (COLLAPSED.has(key)) { COLLAPSED.delete(key); COLLAPSED.add('__EXPAND__:' + key); }
            else { COLLAPSED.add(key); COLLAPSED.delete('__EXPAND__:' + key); }
            smoothSwap(() => renderGraph());
          } else if (path) {
            const f = FILES_BY_PATH.get(path);
            if (f) smoothSwap(() => selectFile(f));
          }
        });

        // Keyboard on nodes: Enter / Space
        svgEl.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          const g = ev.target.closest('.dep-node'); if (!g) return;
          ev.preventDefault();
          g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }
`;

const before = lines.slice(0, beforeIdx).join('\n');
const after = lines.slice(afterIdx).join('\n');
fs.writeFileSync('prototype/index.html', before + newBlock + '\n' + after);
console.log('replaced');
