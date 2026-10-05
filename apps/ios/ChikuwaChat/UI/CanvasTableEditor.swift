import SwiftUI
import UIKit

/// M57: the canvas table editor (CANVAS.md §17), full screen. By default one card per row — the header first, its cells
/// the column names with each column's menu (位置揃え, 左/右に列を追加, 列を削除) — and the cells stacked as text fields
/// labelled by the header; 「表の形」 shows the table as a grid that scrolls sideways. 完了 hands the table back to the
/// canvas editor, which writes it into the text; キャンセル changes nothing.
struct CanvasTableEditor: View {
    enum Layout: String, CaseIterable, Identifiable {
        case cards
        case grid
        var id: String { rawValue }
        var label: String { self == .cards ? tr("行ごと") : tr("表の形") }
    }

    let target: CanvasTable.Target
    let onDone: (CanvasTable.Table) -> Void
    let onCancel: () -> Void
    @State private var table: CanvasTable.Table
    @State private var layout: Layout

    init(target: CanvasTable.Target, layout: Layout = .cards, onDone: @escaping (CanvasTable.Table) -> Void, onCancel: @escaping () -> Void) {
        self.target = target
        self.onDone = onDone
        self.onCancel = onCancel
        _table = State(initialValue: target.table)
        _layout = State(initialValue: layout)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("表示", selection: $layout) {
                    ForEach(Layout.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                Divider()
                switch layout {
                case .cards: cards
                case .grid: grid
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(target.isNew ? "表を追加" : "表を編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { onCancel() } }
                ToolbarItem(placement: .confirmationAction) { Button("完了") { onDone(table) }.fontWeight(.semibold) }
            }
        }
    }

    private var columns: Range<Int> { 0..<table.columnCount }

    // MARK: the cards

    private var cards: some View {
        ScrollView {
            VStack(spacing: 12) {
                headerCard
                ForEach(table.rows.indices, id: \.self) { r in rowCard(r) }
                Button {
                    table = CanvasTable.addRow(table, at: table.rows.count)
                } label: {
                    Label("行を追加", systemImage: "plus")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var headerCard: some View {
        card {
            HStack {
                Text("見出し").font(.headline)
                Spacer()
                Text("\(table.columnCount) 列").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(columns, id: \.self) { c in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text("\(c + 1) 列目")
                        if let align = table.align[safe: c] ?? nil {
                            Label(Self.alignName(align), systemImage: Self.alignIcon(align)).labelStyle(.titleAndIcon)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        field(headerBinding(c), prompt: tr("列の名前"), column: c)
                            .fontWeight(.semibold)
                            .accessibilityLabel("\(c + 1) 列目の見出し")
                        columnMenu(c)
                    }
                }
            }
        }
    }

    private func rowCard(_ r: Int) -> some View {
        card {
            HStack {
                Text("行 \(r + 1)").font(.headline)
                Spacer()
                rowMenu(r)
            }
            ForEach(columns, id: \.self) { c in
                VStack(alignment: .leading, spacing: 4) {
                    Text(label(c)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    field(cellBinding(r, c), prompt: "", column: c)
                        .accessibilityLabel("行 \(r + 1)、\(label(c))")
                }
            }
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10, content: content)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemGroupedBackground)))
    }

    private func field(_ text: Binding<String>, prompt: String, column: Int) -> some View {
        TextField(prompt, text: text)
            .textFieldStyle(.plain)
            .textInputAutocapitalization(.never)
            .multilineTextAlignment(Self.textAlignment(table.align[safe: column] ?? nil))
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(.tertiarySystemFill)))
    }

    private func columnMenu(_ c: Int) -> some View {
        Menu {
            Picker(selection: alignBinding(c)) {
                Label("なし", systemImage: "minus").tag(CanvasTable.Align?.none)
                ForEach(CanvasTable.Align.allCases, id: \.self) { align in
                    Label(Self.alignName(align), systemImage: Self.alignIcon(align)).tag(CanvasTable.Align?.some(align))
                }
            } label: {
                Label("位置揃え", systemImage: "text.alignleft")
            }
            .pickerStyle(.menu)
            Divider()
            Button { table = CanvasTable.addColumn(table, at: c) } label: { Label("左に列を追加", systemImage: "arrow.left.to.line") }
            Button { table = CanvasTable.addColumn(table, at: c + 1) } label: { Label("右に列を追加", systemImage: "arrow.right.to.line") }
            Divider()
            Button(role: .destructive) { table = CanvasTable.deleteColumn(table, at: c) } label: { Label("列を削除", systemImage: "trash") }
                .disabled(table.columnCount <= 1)
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("\(c + 1) 列目の操作")
    }

    private func rowMenu(_ r: Int) -> some View {
        Menu {
            Button { table = CanvasTable.addRow(table, at: r) } label: { Label("上に行を追加", systemImage: "arrow.up.to.line") }
            Button { table = CanvasTable.addRow(table, at: r + 1) } label: { Label("下に行を追加", systemImage: "arrow.down.to.line") }
            Divider()
            Button { table = CanvasTable.moveRow(table, from: r, to: r - 1) } label: { Label("上へ", systemImage: "arrow.up") }
                .disabled(r == 0)
            Button { table = CanvasTable.moveRow(table, from: r, to: r + 1) } label: { Label("下へ", systemImage: "arrow.down") }
                .disabled(r >= table.rows.count - 1)
            Divider()
            Button(role: .destructive) { table = CanvasTable.deleteRow(table, at: r) } label: { Label("行を削除", systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("行 \(r + 1) の操作")
    }

    // MARK: the grid

    private var grid: some View {
        // Nested (not one two-axis view): a table smaller than the screen sits at the top left, not in the middle.
        ScrollView(.vertical) {
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(columns, id: \.self) { c in gridCell(table.header[c], column: c, header: true) }
                    }
                    ForEach(table.rows.indices, id: \.self) { r in
                        GridRow {
                            ForEach(columns, id: \.self) { c in gridCell(table.rows[r][safe: c] ?? "", column: c, header: false) }
                        }
                    }
                }
                .overlay(Rectangle().stroke(Color(.separator), lineWidth: 1))
                .padding(16)
            }
        }
        .accessibilityLabel("表の形")
    }

    private func gridCell(_ text: String, column: Int, header: Bool) -> some View {
        let align = table.align[safe: column] ?? nil
        return Text(text)
            .font(header ? .subheadline.weight(.semibold) : .subheadline)
            .multilineTextAlignment(Self.textAlignment(align))
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: columnWidth(column), alignment: Self.frameAlignment(align))
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(header ? Color(.tertiarySystemFill) : Color(.secondarySystemGroupedBackground))
            .overlay(Rectangle().stroke(Color(.separator), lineWidth: 0.5))
    }

    /// The widest cell of the column (measured), between 56 and 240 points: longer cells wrap.
    private func columnWidth(_ c: Int) -> CGFloat {
        let font = UIFont.preferredFont(forTextStyle: .subheadline)
        let bold = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)
        var widest = ((table.header[safe: c] ?? "") as NSString).size(withAttributes: [.font: bold]).width
        for row in table.rows {
            widest = max(widest, ((row[safe: c] ?? "") as NSString).size(withAttributes: [.font: font]).width)
        }
        return min(240, max(56, ceil(widest)))
    }

    // MARK: bindings and names

    private func label(_ c: Int) -> String {
        let name = (table.header[safe: c] ?? "").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? tr("\(c + 1) 列目") : name
    }

    private func headerBinding(_ c: Int) -> Binding<String> {
        Binding(get: { table.header[safe: c] ?? "" }, set: { value in
            if table.header.indices.contains(c) { table.header[c] = value }
        })
    }

    private func cellBinding(_ r: Int, _ c: Int) -> Binding<String> {
        Binding(get: { table.rows[safe: r]?[safe: c] ?? "" }, set: { value in
            if table.rows.indices.contains(r) && table.rows[r].indices.contains(c) { table.rows[r][c] = value }
        })
    }

    private func alignBinding(_ c: Int) -> Binding<CanvasTable.Align?> {
        Binding(get: { table.align[safe: c] ?? nil }, set: { table = CanvasTable.setAlign(table, column: c, $0) })
    }

    static func alignName(_ align: CanvasTable.Align) -> String {
        switch align {
        case .left: return tr("左")
        case .center: return tr("中央")
        case .right: return tr("右")
        }
    }

    static func alignIcon(_ align: CanvasTable.Align) -> String {
        switch align {
        case .left: return "text.alignleft"
        case .center: return "text.aligncenter"
        case .right: return "text.alignright"
        }
    }

    private static func textAlignment(_ align: CanvasTable.Align?) -> TextAlignment {
        switch align {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }

    private static func frameAlignment(_ align: CanvasTable.Align?) -> Alignment {
        switch align {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
