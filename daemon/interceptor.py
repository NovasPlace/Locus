import sys
import time

try:
    from pynput import mouse, keyboard
except ImportError:
    print("pynput not installed")
    sys.exit(1)

import subprocess

# State
is_dragging = False
drag_start_pos = None

def get_clipboard():
    try:
        # Try retrieving xclip primary selection (highlighted text implicitly copied on Linux X11)
        res = subprocess.run(['xclip', '-o', '-selection', 'primary'], capture_output=True, text=True, timeout=1)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout
        
        # Fallback to general clipboard
        res = subprocess.run(['xclip', '-o', '-selection', 'clipboard'], capture_output=True, text=True, timeout=1)
        if res.returncode == 0:
            return res.stdout
    except Exception as e:
        return f"[Error getting clipboard: {e}]"
    return ""

def on_click(x, y, button, pressed):
    global is_dragging, drag_start_pos
    
    # Only care about left click
    if button != mouse.Button.left:
        return

    if pressed:
        is_dragging = True
        drag_start_pos = (x, y)
    else:
        if is_dragging and drag_start_pos:
            # Check if this was a drag or just a click
            dx = abs(x - drag_start_pos[0])
            dy = abs(y - drag_start_pos[1])
            
            # If moved more than 10 pixels, consider it a drag/highlight
            if dx > 10 or dy > 10:
                print(f"\\n[*] Highlight drag detected. End coordinates: ({x}, {y})")
                
                # Sleep briefly to ensure the OS has time to copy the highlighted text to the primary selection
                time.sleep(0.1)
                
                text = get_clipboard()
                if text:
                    print(f"[>] Captured {len(text)} chars: {text[:50]}...")
                else:
                    print("[!] Drag detected, but primary X11 selection was empty. (May require explicit Ctrl+C depending on the app)")
                    
        is_dragging = False
        drag_start_pos = None

def on_press(key):
    # Exit on Esc
    if key == keyboard.Key.esc:
        print("Exiting...")
        return False

print("Starting Locus OS Interceptor test... Highlight some text anywhere and see if it captures. Press Esc to exit.")

# Setup listeners
mouse_listener = mouse.Listener(on_click=on_click)
mouse_listener.start()

with keyboard.Listener(on_press=on_press) as k_listener:
    k_listener.join()

