import AppKit
import OSLog
import UserNotifications

final class NotificationApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        guard arguments.count == 5, arguments[1] == "notify" else {
            // Notification Center relaunches the app without our CLI arguments.
            // Allow its response callback to arrive, then exit if opened directly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(EXIT_FAILURE) }
            return
        }

        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { allowed, error in
            guard allowed, error == nil else { exit(EXIT_FAILURE) }
            let content = UNMutableNotificationContent()
            content.title = arguments[2]
            content.body = arguments[3]
            content.userInfo = ["app": arguments[4]]
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request) { error in exit(error == nil ? EXIT_SUCCESS : EXIT_FAILURE) }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let bundleID = response.notification.request.content.userInfo["app"] as? String else {
            completionHandler()
            exit(EXIT_SUCCESS)
        }
        center.removeDeliveredNotifications(withIdentifiers: [response.notification.request.identifier])
        DispatchQueue.main.async {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first {
                let activated = app.activate(options: [.activateIgnoringOtherApps])
                Logger(subsystem: "dev.kimchi.notifications", category: "activation")
                    .notice("Notification app activation succeeded: \(activated, privacy: .public)")
                completionHandler()
                exit(activated ? EXIT_SUCCESS : EXIT_FAILURE)
            }
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
                completionHandler()
                exit(EXIT_FAILURE)
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                completionHandler()
                exit(error == nil ? EXIT_SUCCESS : EXIT_FAILURE)
            }
        }
    }
}

let application = NSApplication.shared
let delegate = NotificationApp()
application.delegate = delegate
application.setActivationPolicy(.accessory)
UNUserNotificationCenter.current().delegate = delegate
application.run()
