#!/usr/bin/env python3
"""Run the shared matrix page in the installed WebKitGTK GI runtime."""

import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} URL RESULT.json", file=sys.stderr)
        return 2
    url, output = sys.argv[1], Path(sys.argv[2])
    window = Gtk.Window(title="Fernwork WebView Matrix")
    window.set_default_size(1440, 900)
    view = WebKit2.WebView()
    window.add(view)
    window.connect("destroy", Gtk.main_quit)

    def poll() -> bool:
        view.run_javascript("document.querySelector('#matrix-result')?.textContent || ''", None, finished, None)
        return True

    def finished(webview, task, _data) -> None:
        try:
            value = webview.run_javascript_finish(task).get_js_value().to_string()
            parsed = json.loads(value)
        except (GLib.Error, json.JSONDecodeError):
            return
        output.write_text(json.dumps(parsed, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(parsed, indent=2))
        Gtk.main_quit()

    view.load_uri(url)
    window.show_all()
    GLib.timeout_add_seconds(2, poll)
    GLib.timeout_add_seconds(900, lambda: (print("WebKitGTK measurement timed out", file=sys.stderr), Gtk.main_quit(), False)[2])
    Gtk.main()
    return 0 if output.exists() else 1


if __name__ == "__main__":
    raise SystemExit(main())
