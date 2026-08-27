import WidgetKit
import SwiftUI

private let appGroupID = "group.com.hybes.http-widget"
private let snapshotFilename = "widget-snapshot.json"
private let snapshotDirectory = "Library/Application Support"

struct Snapshot: Decodable {
    struct Point: Decodable {
        let timestamp: Int64
        let value: Double
    }

    struct Item: Decodable {
        let id: String
        let name: String
        let value: String?
        let error: String?
        let points: [Point]

        private enum CodingKeys: String, CodingKey {
            case id, name, value, error, points
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decode(String.self, forKey: .name)
            value = try container.decodeIfPresent(String.self, forKey: .value)
            error = try container.decodeIfPresent(String.self, forKey: .error)
            // A malformed or pre-v2 series must not make the whole widget blank.
            points = (try? container.decode([Point].self, forKey: .points)) ?? []
        }
    }

    let generatedAt: Double?
    let items: [Item]?
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let items: [Snapshot.Item]
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: .now, items: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, items: loadItems()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let entry = SnapshotEntry(date: .now, items: loadItems())
        let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: .now) ?? .now.addingTimeInterval(900)
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }

    private func loadItems() -> [Snapshot.Item] {
        guard let group = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        ) else { return [] }

        let current = group
            .appendingPathComponent(snapshotDirectory, isDirectory: true)
            .appendingPathComponent(snapshotFilename)
        // Retain a read-only fallback for devices that already have the
        // pre-iOS-27 root-level snapshot. The app always writes the new path.
        let legacy = group.appendingPathComponent(snapshotFilename)
        guard let snapshot = [current, legacy].lazy.compactMap({ url -> Snapshot? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(Snapshot.self, from: data)
        }).first else { return [] }
        return snapshot.items ?? []
    }
}

private extension Snapshot.Item {
    var hasError: Bool {
        error?.isEmpty == false
    }

    var displayValue: String {
        if hasError {
            if let value, !value.isEmpty { return "⚠ " + value }
            return "⚠ " + (error ?? name)
        }
        if let value, !value.isEmpty { return value }
        return "–"
    }

    /// Invalid values are ignored and time order is enforced at the rendering
    /// boundary, so every native surface gets a safe, predictable series.
    var graphPoints: [Snapshot.Point] {
        points
            .filter { $0.value.isFinite }
            .sorted { lhs, rhs in lhs.timestamp < rhs.timestamp }
    }

    var hasGraph: Bool {
        graphPoints.count >= 2
    }
}

private struct SparklineShape: Shape {
    let points: [Snapshot.Point]

    func path(in rect: CGRect) -> Path {
        let valid = points
            .filter { $0.value.isFinite }
            .sorted { lhs, rhs in lhs.timestamp < rhs.timestamp }
        guard valid.count >= 2, rect.width > 0, rect.height > 0 else {
            return Path()
        }

        let values = valid.map(\.value)
        guard let minimumValue = values.min(), let maximumValue = values.max() else {
            return Path()
        }

        let minimumTime = Double(valid.first?.timestamp ?? 0)
        let maximumTime = Double(valid.last?.timestamp ?? 0)
        let timeRange = maximumTime - minimumTime
        let valueRange = maximumValue - minimumValue
        let drawingRect = rect.insetBy(dx: 1, dy: min(2, rect.height / 4))

        let vertices = valid.enumerated().map { index, point -> CGPoint in
            let xFraction: Double
            if timeRange > 0, timeRange.isFinite {
                xFraction = (Double(point.timestamp) - minimumTime) / timeRange
            } else {
                xFraction = Double(index) / Double(valid.count - 1)
            }

            let yFraction: Double
            if valueRange > 0, valueRange.isFinite {
                yFraction = (point.value - minimumValue) / valueRange
            } else {
                yFraction = 0.5
            }

            return CGPoint(
                x: drawingRect.minX + drawingRect.width * xFraction,
                y: drawingRect.maxY - drawingRect.height * yFraction
            )
        }

        var path = Path()
        path.addLines(vertices)
        return path
    }
}

extension View {
    @ViewBuilder
    func widgetBackground() -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) { Color.clear }
        } else {
            self
        }
    }
}

struct ItemText: View {
    let item: Snapshot.Item

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(item.name)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(item.displayValue)
                .font(.title3.weight(.semibold))
                .foregroundStyle(item.hasError ? Color.orange : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
    }
}

private struct ValueRow: View {
    let item: Snapshot.Item

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(item.name)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(item.displayValue)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(item.hasError ? Color.orange : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
    }
}

private struct GraphItem: View {
    let item: Snapshot.Item

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ValueRow(item: item)
            SparklineShape(points: item.graphPoints)
                .stroke(
                    item.hasError ? Color.orange : Color.accentColor,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                )
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.name), \(item.displayValue)")
    }
}

struct HttpWidgetsWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .widgetBackground()
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .systemSmall:
            small
        case .systemMedium:
            medium
        case .accessoryInline:
            inline
        case .accessoryRectangular:
            rectangular
        case .accessoryCircular:
            circular
        default:
            small
        }
    }

    private var emptyState: some View {
        Text("Open HTTP Widgets")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private var firstGraphItem: Snapshot.Item? {
        entry.items.first(where: \.hasGraph)
    }

    private var small: some View {
        Group {
            if entry.items.isEmpty {
                emptyState
            } else if let item = firstGraphItem {
                GraphItem(item: item)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(entry.items.prefix(2), id: \.id) { item in
                        ItemText(item: item)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .padding(2)
    }

    private var medium: some View {
        Group {
            if entry.items.isEmpty {
                emptyState
            } else if let graphItem = firstGraphItem {
                VStack(alignment: .leading, spacing: 6) {
                    GraphItem(item: graphItem)
                        .frame(maxHeight: .infinity)
                    ForEach(entry.items.filter { $0.id != graphItem.id }.prefix(2), id: \.id) { item in
                        ValueRow(item: item)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(entry.items.prefix(4), id: \.id) { item in
                        ValueRow(item: item)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .padding(6)
    }

    private var inline: some View {
        if let first = entry.items.first {
            Text(first.displayValue)
        } else {
            Text("Open HTTP Widgets")
        }
    }

    private var rectangular: some View {
        Group {
            if entry.items.isEmpty {
                emptyState
            } else if let item = firstGraphItem {
                GraphItem(item: item)
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(entry.items.prefix(2), id: \.id) { item in
                        Text("\(item.name): \(item.displayValue)")
                            .font(.caption)
                            .foregroundStyle(item.hasError ? Color.orange : .primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                }
            }
        }
    }

    private var circular: some View {
        Group {
            if let first = entry.items.first {
                Text(first.displayValue)
                    .font(.headline)
                    .foregroundStyle(first.hasError ? Color.orange : .primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.4)
                    .padding(2)
            } else {
                Text("—")
                    .font(.headline)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct HttpWidgetsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HttpWidgetsWidget", provider: SnapshotProvider()) { entry in
            HttpWidgetsWidgetView(entry: entry)
        }
        .configurationDisplayName("HTTP Widgets")
        .description("Values served over HTTP.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryInline, .accessoryRectangular, .accessoryCircular])
    }
}
