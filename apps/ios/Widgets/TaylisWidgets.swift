import SwiftUI
import WidgetKit

/// The widget extension: the 在室状況 widget (home screen small / medium, lock screen) and, on iOS 18, the control that
/// switches between 在室 and 帰宅 from Control Center and the lock screen.
@main
struct TaylisWidgets: WidgetBundle {
    var body: some Widget {
        AttendanceWidget()
        if #available(iOS 18.0, *) {
            AttendanceControl()
        }
    }
}
