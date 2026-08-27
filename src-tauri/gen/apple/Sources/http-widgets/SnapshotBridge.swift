import Foundation
import UIKit
#if DEBUG
import WebKit
#endif
#if canImport(WidgetKit)
import WidgetKit
#endif

private let appGroupID = "group.com.hybes.http-widget"
private let snapshotFilename = "widget-snapshot.json"
// Keep shared state in the standard durable Library subtree. Both targets can
// access it, and current device tooling can inspect it during diagnostics.
private let snapshotDirectory = "Library/Application Support"
private let pollInterval: TimeInterval = 5

enum SnapshotBridge {
    private static var lastCopiedModificationDate: Date?
    private static var pollTimer: Timer?

    static func install() {
        syncSnapshot()
        // Installation happens before UIApplicationMain enters the run loop.
        // Register the timer now so it is already present when that loop starts;
        // relying only on didBecomeActive can miss the initial activation on a
        // cold launch and leave the widget stuck on the first copied snapshot.
        startPollingIfNeeded()
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            syncSnapshot()
            startPollingIfNeeded()
            retryFailedDevelopmentServerIfNeeded()
        }
    }

    static func syncSnapshot() {
        let fm = FileManager.default
        guard let group = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroupID) else {
            return
        }
        let directory = group.appendingPathComponent(snapshotDirectory, isDirectory: true)
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            NSLog("HTTP Widgets: could not create the shared snapshot directory: \(error)")
            return
        }
        let destination = directory.appendingPathComponent(snapshotFilename)

        guard let source = findSnapshotSource(fm) else {
            writeEmptySnapshot(to: destination)
            reloadWidgets()
            return
        }

        let modified = modificationDate(of: source)
        if !forceCopy, let modified, modified == lastCopiedModificationDate,
           fm.fileExists(atPath: destination.path) {
            return
        }

        let temporary = directory.appendingPathComponent("widget-snapshot.tmp")
        try? fm.removeItem(at: temporary)
        do {
            try fm.copyItem(at: source, to: temporary)
            if fm.fileExists(atPath: destination.path) {
                _ = try fm.replaceItemAt(destination, withItemAt: temporary)
            } else {
                try fm.moveItem(at: temporary, to: destination)
            }
            try? fm.removeItem(at: temporary)
            lastCopiedModificationDate = modified
            reloadWidgets()
        } catch {
            try? fm.removeItem(at: temporary)
            NSLog("HTTP Widgets: could not update the shared widget snapshot: \(error)")
        }
    }

    private static var forceCopy: Bool { lastCopiedModificationDate == nil }

    private static func startPollingIfNeeded() {
        guard pollTimer == nil else { return }
        let timer = Timer(timeInterval: pollInterval, repeats: true) { _ in
            syncSnapshot()
        }
        // Common mode keeps the bridge alive while the user scrolls or another
        // UIKit control temporarily switches the main run-loop mode.
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private static func findSnapshotSource(_ fm: FileManager) -> URL? {
        candidateDirectories(fm)
            .lazy
            .map { $0.appendingPathComponent(snapshotFilename) }
            .first { fm.fileExists(atPath: $0.path) }
    }

    private static func candidateDirectories(_ fm: FileManager) -> [URL] {
        var candidates = fm.urls(for: .documentDirectory, in: .userDomainMask)
        candidates.append(contentsOf: fm.urls(for: .applicationSupportDirectory, in: .userDomainMask))
        if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            candidates.append(support.appendingPathComponent("com.hybes.http-widget"))
        }
        candidates.append(contentsOf: fm.urls(for: .libraryDirectory, in: .userDomainMask))
        candidates.append(URL(fileURLWithPath: NSHomeDirectory()))
        return candidates
    }

    private static func modificationDate(of url: URL) -> Date? {
        try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
    }

    private static func writeEmptySnapshot(to destination: URL) {
        guard let empty = #"{"generatedAt":0,"items":[]}"#.data(using: .utf8) else { return }
        try? empty.write(to: destination)
    }

    private static func reloadWidgets() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }

    /// iOS may reject the first LAN navigation immediately while its privacy
    /// prompt is still open. Tauri's physical-device development error page
    /// otherwise tells the developer to restart the whole app. In debug builds
    /// only, retry that exact error page when the app becomes active again.
    private static func retryFailedDevelopmentServerIfNeeded() {
        #if DEBUG
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
            for window in windows {
                for webView in webViews(in: window) {
                    webView.evaluateJavaScript(
                        "document.body && document.body.innerText.includes('Failed to request')"
                    ) { value, _ in
                        if value as? Bool == true {
                            webView.reload()
                        }
                    }
                }
            }
        }
        #endif
    }

    #if DEBUG
    private static func webViews(in view: UIView) -> [WKWebView] {
        var result = view.subviews.flatMap { webViews(in: $0) }
        if let webView = view as? WKWebView {
            result.append(webView)
        }
        return result
    }
    #endif
}

@_cdecl("snapshot_bridge_install")
public func snapshot_bridge_install() {
    SnapshotBridge.install()
}
