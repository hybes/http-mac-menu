import BackgroundTasks
import Foundation
import UIKit

/// Must match BGTaskSchedulerPermittedIdentifiers in the Info.plist.
private let taskIdentifier = "com.hybes.http-widget.refresh"

/// iOS never runs a refresh sooner than this, and usually waits a good deal
/// longer — it learns from how often the app is opened. Asking for less does
/// not make it come sooner, so this is the honest floor rather than a target.
private let earliestInterval: TimeInterval = 15 * 60

private final class TaskCompletionGate {
    private let lock = NSLock()
    private var completed = false

    func finish(_ task: BGTask, success: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard !completed else { return }
        completed = true
        task.setTaskCompleted(success: success)
    }
}

private final class TaskCancellationFlag {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

/// Implemented in Rust (src/ios_background.rs). Preparing synchronously gives
/// an expiration callback a task-specific token even if the worker has not yet
/// started. The run function returns 1 only when work completed in its budget.
@_silgen_name("http_widgets_background_refresh_prepare")
private func rustBackgroundRefreshPrepare() -> UInt64

@_silgen_name("http_widgets_background_refresh")
private func rustBackgroundRefresh(_ taskID: UInt64) -> Int32

@_silgen_name("http_widgets_background_refresh_cancel")
private func rustBackgroundRefreshCancel(_ taskID: UInt64)

enum BackgroundRefresh {
    /// Registration has to happen before the app finishes launching, so this is
    /// called from main.mm ahead of `start_app()`.
    static func install() {
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: taskIdentifier,
            using: nil
        ) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task)
        }
        if !registered {
            NSLog("HTTP Widgets: could not register \(taskIdentifier)")
        }

        // One in the queue at all times: the app is only ever woken for a task
        // that was submitted before it was suspended or killed.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            schedule()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didFinishLaunchingNotification,
            object: nil,
            queue: .main
        ) { _ in
            schedule()
        }
    }

    /// Submitting again with the same identifier replaces the pending request
    /// rather than queueing a second one, so this is safe to call often.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: earliestInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Denied when the user has switched Background App Refresh off, or
            // while the app is in the foreground on some builds. Neither is
            // fatal: the foreground tick still covers the app being open.
            NSLog("HTTP Widgets: could not schedule a refresh — \(error)")
        }
    }

    private static func handle(_ task: BGAppRefreshTask) {
        // Queue the next one first. If the work below overruns and iOS kills
        // the process, a request is already in for the next window.
        schedule()

        let completion = TaskCompletionGate()
        let cancellation = TaskCancellationFlag()
        let taskID = rustBackgroundRefreshPrepare()
        let work = DispatchWorkItem {
            let ok = rustBackgroundRefresh(taskID) == 1
            if ok && !cancellation.isCancelled {
                SnapshotBridge.syncSnapshot()
            }
            completion.finish(task, success: ok)
        }

        // iOS calls this when the window is nearly up. Completing here rather
        // than being killed is what keeps the app's refresh budget intact. A
        // DispatchWorkItem cannot stop a closure that is already executing, so
        // signal Rust as well; it drops the in-flight async refresh batch.
        task.expirationHandler = {
            cancellation.cancel()
            rustBackgroundRefreshCancel(taskID)
            work.cancel()
            completion.finish(task, success: false)
        }

        DispatchQueue.global(qos: .utility).async(execute: work)
    }
}

@_cdecl("background_refresh_install")
public func background_refresh_install() {
    BackgroundRefresh.install()
}
