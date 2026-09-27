//! 网格渲染：从 alacritty `Term` 网格产出含 scrollback 的纯文本快照。

use alacritty_terminal::term::Term;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::event::EventListener;

/// 自定义尺寸：cols × rows 屏幕 + scrollback 历史。
#[derive(Debug, Clone, Copy)]
pub struct GridSize {
    pub cols: usize,
    pub rows: usize,
    pub scrollback: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows + self.scrollback
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// 渲染整屏（含 scrollback）为纯文本。
/// 逻辑行跨视觉行（WRAPLINE）时合并；其余行以 \n 结尾。
pub fn render_text<T: EventListener>(term: &Term<T>) -> String {
    let grid = term.grid();
    let cols = grid.columns();
    let topmost = grid.topmost_line();
    let last = Line(grid.screen_lines() as i32 - 1);

    let mut out = String::new();
    let mut line = topmost;
    while line <= last {
        let mut row = String::with_capacity(cols);
        for col in 0..cols {
            let cell = &grid[line][Column(col)];
            if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            row.push(cell.c);
        }
        // WRAPLINE：该行尾列有此 flag 表示逻辑行未结束
        let wrapped = grid[line][Column(cols - 1)].flags.contains(Flags::WRAPLINE);
        let trimmed = row.trim_end();
        out.push_str(trimmed);
        if !wrapped {
            out.push('\n');
        }
        line = Line(line.0 + 1);
    }
    // 收尾：最后一行若 wrapped 残留，补齐
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// 渲染可见屏幕（不含 scrollback）为纯文本。
pub fn render_screen_only<T: EventListener>(term: &Term<T>) -> String {
    let grid = term.grid();
    let cols = grid.columns();
    let first = Line(0);
    let last = Line(grid.screen_lines() as i32 - 1);

    let mut out = String::new();
    let mut line = first;
    while line <= last {
        let mut row = String::with_capacity(cols);
        for col in 0..cols {
            let cell = &grid[line][Column(col)];
            if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            row.push(cell.c);
        }
        out.push_str(row.trim_end());
        out.push('\n');
        line = Line(line.0 + 1);
    }
    out
}

/// 光标位置（视觉行从 0 计，行 0 = 屏幕顶行）。
pub fn cursor_pos<T: EventListener>(term: &Term<T>) -> (u16, u16) {
    let content = term.renderable_content();
    let p = content.cursor.point;
    let row = (p.line.0).clamp(0, term.grid().screen_lines() as i32 - 1) as u16;
    let col = p.column.0 as u16;
    (row, col)
}
