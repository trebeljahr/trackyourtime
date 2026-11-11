
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(args) {
  var pid = Number(args[0]);
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front || Number(front.processIdentifier) !== pid) return JSON.stringify(null);
  var windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17, 0)) || [];
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    if (w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && typeof w.kCGWindowName === 'string') {
      return JSON.stringify(w.kCGWindowName.slice(0, 2000));
    }
  }
  return JSON.stringify(null);
}