import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Register for remote notifications on launch so APNs can deliver
        // push events to the @capacitor/push-notifications plugin. The
        // plugin's iOS impl handles token persistence + event emission
        // back to the JS bridge; the only thing we need to do is call
        // registerForRemoteNotifications() and forward the result.
        //
        // The plugin internally listens for didRegisterForRemoteNotifications
        // via method swizzling, so we don't strictly need to forward it
        // manually — but we add the explicit forwarding here as
        // defense-in-depth in case a future Capacitor version changes
        // the swizzle behavior.
        application.registerForRemoteNotifications()
        return true
    }

    // MARK: - APNs token + error forwarding (defense-in-depth)
    //
    // Capacitor's @capacitor/push-notifications plugin normally picks
    // these up via swizzling. We forward them explicitly so the JS
    // bridge gets the device token even if swizzling breaks in a
    // future Capacitor release.

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        NSLog("[EduSupervise] APNs token registered (length=\(token.count))")
        // Forward to the Capacitor plugin via the standard notification
        // name. The plugin listens for this and emits a `registration`
        // event to the JS layer.
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: nil,
            userInfo: ["deviceToken": token]
        )
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[EduSupervise] APNs registration failed: \(error.localizedDescription)")
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: nil,
            userInfo: ["error": error]
        )
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // For silent pushes (content-available=1) — let the Capacitor
        // plugin handle delivery back to the JS layer.
        completionHandler(.newData)
    }

    // MARK: - Standard lifecycle hooks (unchanged from Capacitor template)

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}