import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

Item {
  id: root
  property var pluginApi: null

  property bool blinking: false
  property string tooltipText: ""

  IpcHandler {
    target: "plugin:corner-alert"

    function blink() {
      root.blinking = true;
      root.tooltipText = "";
    }

    function blinkWithMessage(message: string) {
      root.blinking = true;
      root.tooltipText = message || "";
    }

    function stop() {
      root.blinking = false;
      root.tooltipText = "";
    }
  }

  Variants {
    model: Quickshell.screens

    PanelWindow {
      property var modelData

      visible: root.blinking

      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.namespace: "corner-alert"

      anchors {
        top: true
        bottom: true
        left: true
        right: true
      }

      exclusionMode: ExclusionMode.Ignore
      color: "transparent"

      // Empty click mask so all clicks pass through.
      mask: Region {}

      Rectangle {
        anchors.centerIn: parent
        width: 20
        height: 20
        radius: 10
        color: "#ff3333"
        opacity: 1.0

        SequentialAnimation on opacity {
          running: root.blinking
          loops: Animation.Infinite
          NumberAnimation { to: 0.15; duration: 231; easing.type: Easing.InOutSine }
          NumberAnimation { to: 1.0; duration: 231; easing.type: Easing.InOutSine }
        }
      }
    }
  }
}
