/**
 * 列表懒加载工具（增量渲染）
 * 目标：列表只渲染「当前可见 + 少量缓冲」的节点，向下滚动才追加下一批，
 *      即「只加载当前页面，滑动多少加载多少」，大幅降低长列表的 DOM / 内存占用。
 *
 *  - SongListLazy：歌曲表格（SongTable）增量渲染。调用方仍把全量 songs 交给它，
 *    它只把前 N 首交给 SongTable.render，滚动接近底部时追加下一批（整段重绘已渲染部分）。
 *  - CardListLazy：封面卡片网格（media-card-grid 等）增量渲染。调用方给出
 *    getGrid() 与 cardHtml(song, i)，它负责只渲染前 N 张卡片，滚动到底追加。
 *
 * 两者都按唯一 key / pageId 维护「已渲染条数」，同一份数据再次 register 时保留进度
 * （例如管理模式切换导致整表重绘，不会把滚动位置重置回顶部）。
 */
(function () {
    'use strict';

    const SCROLL_NEAR = 150; // 距底部多少像素触发加载更多

    // ============== 歌曲表格懒加载 ==============
    const SongListLazy = {
        _ctx: new Map(),
        _bound: false,

        /**
         * @param {string} pageId
         * @param {Array} songs      全量歌曲
         * @param {HTMLElement} container  SongTable.render 的 container
         * @param {Function} render     (slice) => void  内部调用 SongTable.render({ ... songs: slice })
         * @param {object} [opts]       { batch=50, initial=60 }
         */
        /**
         * @param {string} pageId
         * @param {Array} songs      全量歌曲（非分页模式）
         * @param {HTMLElement} container  SongTable.render 的 container
         * @param {Function} render     (slice) => void  内部调用 SongTable.render({ ... songs: slice })
         * @param {object} [opts]       { batch=50, initial=60, fetchPage?, fetchKey? }
         *   fetchPage(key, offset, limit) => Promise<{ songs:Array, total?:number, hasMore?:boolean }>
         *     分页模式：只拉当前需要的部分，滚动到底才拉下一页（可视化请求，避免一次性全量进内存）。
         */
        register(pageId, songs, container, render, opts) {
            opts = opts || {};
            const batch = opts.batch || 50;
            const initial = opts.initial || 60;
            const fetchPage = opts.fetchPage || null;
            const prev = this._ctx.get(pageId);

            if (fetchPage) {
                // —— 分页数据源模式（可视化请求）——
                const key = opts.fetchKey || '';
                const keep = prev && prev.isPaged && prev.fetchPage === fetchPage && prev.fetchKey === key;
                const ctx = {
                    isPaged: true, pageId: pageId, container: container, render: render,
                    batch: batch, initial: initial, fetchPage: fetchPage, fetchKey: key,
                    loaded: keep ? prev.loaded : [],
                    rendered: keep ? prev.rendered : 0,
                    total: keep ? prev.total : null,
                    loading: false,
                    done: keep ? prev.done : false
                };
                this._ctx.set(pageId, ctx);
                this._ensureScroll();
                if (ctx.loaded.length === 0) this._loadPage(pageId, true);
                else this._paint(pageId);
                return;
            }

            // —— 全量数组模式（原逻辑，兼容 toplist/recommend/search 等）——
            let rendered = Math.min(songs.length, initial);
            if (prev && prev.songs === songs) rendered = prev.rendered; // 同数据保留进度
            this._ctx.set(pageId, {
                isPaged: false, songs: songs, container: container, render: render,
                batch: batch, initial: initial, rendered: rendered
            });
            this._ensureScroll();
            this._paint(pageId);
        },

        async _loadPage(pageId, isFirst) {
            const c = this._ctx.get(pageId);
            if (!c || !c.isPaged || c.loading || c.done) return;
            c.loading = true;
            try {
                const offset = c.loaded.length;
                const limit = isFirst ? c.initial : c.batch;
                const res = await c.fetchPage(c.fetchKey, offset, limit);
                const list = (res && res.songs) || [];
                for (let i = 0; i < list.length; i++) c.loaded.push(list[i]);
                if (typeof res.total === 'number') c.total = res.total;
                c.rendered = isFirst ? Math.min(c.loaded.length, c.initial) : c.loaded.length;
                if (!res || res.hasMore === false || list.length === 0) c.done = true;
                this._paint(pageId);
            } catch (e) {
                console.error('[SongListLazy] 分页加载失败', e);
            } finally {
                c.loading = false;
                this._paintFooter(pageId);
            }
        },

        _paint(pageId) {
            const c = this._ctx.get(pageId);
            if (!c) return;
            const source = c.isPaged ? c.loaded : c.songs;
            if (!source) return;
            c.render(source.slice(0, c.rendered));
            this._paintFooter(pageId);
            const self = this;
            requestAnimationFrame(function () {
                const wrap = (c.container && c.container.querySelector && c.container.querySelector('.song-table-wrapper')) || c.container;
                if (!wrap) return;
                // 只按视口判断：已渲染内容底部仍在视口内（含缓冲）才继续补批撑满首屏；
                // 一旦超出视口就停，交由 #page-container 的 scroll 监听按需追加。
                // 不能再用 scrollHeight/clientHeight（本地歌曲页 #page-container 高度=整页内容高，会恒真导致整表全量渲染）
                const inView = wrap.getBoundingClientRect().bottom <= window.innerHeight + 300;
                if (c.isPaged) {
                    const total = c.loaded.length + (c.done ? 0 : 1);
                    if (c.rendered < total && inView && !c.loading && !c.done) {
                        self._loadPage(pageId, false);
                    }
                } else if (c.rendered < c.songs.length && inView) {
                    c.rendered = Math.min(c.songs.length, c.rendered + c.batch);
                    self._paint(pageId);
                }
            });
        },

        _paintFooter(pageId) {
            const c = this._ctx.get(pageId);
            if (!c || !c.isPaged) return;
            let foot = c.container.querySelector('.lazy-list-footer');
            if (!foot) {
                foot = document.createElement('div');
                foot.className = 'lazy-list-footer';
                foot.style.cssText = 'text-align:center;color:var(--text-tertiary);padding:14px 0;font-size:13px;';
                c.container.appendChild(foot);
            }
            if (c.loading) foot.textContent = '加载中…';
            else if (c.done) foot.textContent = c.loaded.length ? '没有更多了' : '暂无数据';
            else foot.textContent = '';
        },

        _ensureScroll() {
            if (this._bound) return;
            this._bound = true;
            const sc = document.getElementById('page-container');
            if (!sc) return;
            const self = this;
            sc.addEventListener('scroll', function () {
                self._ctx.forEach(function (c, pageId) {
                    if (!c.container || c.container.offsetParent === null) return; // 不可见页跳过
                    if (c.isPaged) {
                        if (c.done || c.loading) return;
                        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - SCROLL_NEAR) {
                            self._loadPage(pageId, false);
                        }
                        return;
                    }
                    if (c.rendered >= c.songs.length) return;
                    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - SCROLL_NEAR) {
                        c.rendered = Math.min(c.songs.length, c.rendered + c.batch);
                        self._paint(pageId);
                    }
                });
            }, { passive: true });
        },

        reset(pageId) { this._ctx.delete(pageId); }
    };

    // ============== 卡片网格懒加载 ==============
    const CardListLazy = {
        _ctx: new Map(),
        _bound: new Set(),

        /**
         * @param {object} o
         *   key, songs, getGrid:()=>HTMLElement, cardHtml:(song,i)=>string
         *   [batch=36, initial=60, scroller]  scroller 省略则监听 grid 自身（grid 需 overflow-y:auto）
         */
        register(o) {
            const prev = this._ctx.get(o.key);
            let rendered = Math.min(o.songs.length, o.initial || 60);
            if (prev && prev.songs === o.songs) rendered = prev.rendered; // 同数据保留进度
            this._ctx.set(o.key, {
                songs: o.songs, getGrid: o.getGrid, cardHtml: o.cardHtml,
                batch: o.batch || 36, initial: o.initial || 60,
                rendered: rendered, scroller: o.scroller || null
            });
            const grid = o.getGrid();
            if (grid) { this._paint(o.key, grid); this._bindScroll(o.key, grid); }
        },

        _paint(key, grid) {
            const c = this._ctx.get(key);
            if (!c || !grid) return;
            const n = Math.min(c.songs.length, c.rendered);
            grid.innerHTML = c.songs.slice(0, n).map(function (s, i) { return c.cardHtml(s, i); }).join('');
            const self = this;
            requestAnimationFrame(function () {
                const sc = (c.scroller && c.scroller !== grid) ? c.scroller : grid;
                if (c.rendered < c.songs.length && grid.scrollHeight <= sc.clientHeight + 80) {
                    c.rendered = Math.min(c.songs.length, c.rendered + c.batch);
                    self._paint(key, grid);
                }
            });
        },

        _bindScroll(key, grid) {
            const c = this._ctx.get(key);
            const sc = (c.scroller && c.scroller !== grid) ? c.scroller : grid;
            if (this._bound.has(sc)) return;
            this._bound.add(sc);
            const self = this;
            sc.addEventListener('scroll', function () {
                self._ctx.forEach(function (cc, k) {
                    const g = cc.getGrid();
                    if (!g || g.offsetParent === null) return; // 不可见跳过
                    const sc2 = (cc.scroller && cc.scroller !== g) ? cc.scroller : g;
                    if (sc2 !== sc) return; // 只处理本滚动源
                    if (cc.rendered >= cc.songs.length) return;
                    if (g.scrollTop + g.clientHeight >= g.scrollHeight - 120) {
                        cc.rendered = Math.min(cc.songs.length, cc.rendered + cc.batch);
                        self._paint(k, g);
                    }
                });
            }, { passive: true });
        },

        reset(key) { this._ctx.delete(key); }
    };

    window.SongListLazy = SongListLazy;
    window.CardListLazy = CardListLazy;
})();
