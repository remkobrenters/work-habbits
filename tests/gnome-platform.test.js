// This test loads the actual GNOME 50 Mutter/GIO libraries, without a desktop,
// input devices, settings changes or a compositor context.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import {isWayland} from '../extension/logic.js';

if (typeof Meta.is_wayland_compositor !== 'undefined')
    throw new Error('This native API check requires the GNOME 50 library without the legacy query');
if (!isWayland(Meta))
    throw new Error('GNOME 50 must select Wayland without the removed API');
const child = Gio.Subprocess.new(['/usr/bin/python3', '-c', 'print("generated input fixture")'],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
const [ok, stdout] = child.communicate_utf8(null, null);
if (!ok || !child.get_successful() || stdout.trim() !== 'generated input fixture')
    throw new Error('Native GIO must start the system Python helper and read its output');
print('ok: actual GNOME 50 Meta/GIO libraries select Wayland and start the helper');
