-- mini-chat relay launcher for OBS Studio (Windows).
-- Add it in OBS: Tools > Scripts > "+" > relay\obs\mini-chat-relay.lua
-- Starts "node index.mjs run --watch-pid <OBS pid>" when OBS loads the script, and runs
-- "node index.mjs stop" when OBS exits (or the script is removed). The relay also exits by itself
-- if OBS crashes, because it watches the OBS process id. No console window is shown.

local obs = obslua
local ffi = require("ffi")

pcall(ffi.cdef, [[
typedef struct {
  unsigned long cb; char *lpReserved; char *lpDesktop; char *lpTitle;
  unsigned long dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
  unsigned short wShowWindow, cbReserved2; unsigned char *lpReserved2;
  void *hStdInput, *hStdOutput, *hStdError;
} MCR_STARTUPINFOA;
typedef struct { void *hProcess; void *hThread; unsigned long dwProcessId, dwThreadId; } MCR_PROCESS_INFORMATION;
int CreateProcessA(const char *app, char *cmd, void *pa, void *ta, int inherit, unsigned long flags,
                   void *env, const char *cwd, MCR_STARTUPINFOA *si, MCR_PROCESS_INFORMATION *pi);
unsigned long WaitForSingleObject(void *handle, unsigned long ms);
int CloseHandle(void *handle);
unsigned long GetCurrentProcessId(void);
]])

local CREATE_NO_WINDOW = 0x08000000
local settings_node = "node.exe"
local settings_dir = ""
local settings_auto = true
local started = false

local function default_relay_dir()
  -- script_path() is ...\relay\obs\ ; the relay folder is its parent.
  return (script_path():gsub("[/\\]+$", ""):gsub("[/\\][^/\\]+$", ""))
end

local function relay_dir()
  if settings_dir ~= nil and settings_dir ~= "" then return settings_dir end
  return default_relay_dir()
end

local function quote(s) return '"' .. s .. '"' end

-- Runs a command without a console window. Waits up to wait_ms (0 = do not wait).
local function spawn(args, wait_ms)
  local dir = relay_dir()
  local cmd = quote(settings_node) .. " " .. quote(dir .. "\\index.mjs") .. " " .. args
  local buf = ffi.new("char[?]", #cmd + 1, cmd)
  local si = ffi.new("MCR_STARTUPINFOA")
  si.cb = ffi.sizeof(si)
  local pi = ffi.new("MCR_PROCESS_INFORMATION")
  if ffi.C.CreateProcessA(nil, buf, nil, nil, 0, CREATE_NO_WINDOW, nil, dir, si, pi) == 0 then
    obs.script_log(obs.LOG_WARNING, "mini-chat relay: could not start node (check the Node path setting)")
    return false
  end
  if wait_ms and wait_ms > 0 then ffi.C.WaitForSingleObject(pi.hProcess, wait_ms) end
  ffi.C.CloseHandle(pi.hThread)
  ffi.C.CloseHandle(pi.hProcess)
  return true
end

local function start_relay()
  if spawn("run --watch-pid " .. tostring(ffi.C.GetCurrentProcessId()), 0) then
    started = true
    obs.script_log(obs.LOG_INFO, "mini-chat relay: started (status log: LOCALAPPDATA\\MiniChatRelay\\relay.log)")
  end
end

local function stop_relay()
  -- "stop" asks the running relay to send "offline" and exit; wait up to 6 s for it.
  spawn("stop", 6000)
  started = false
  obs.script_log(obs.LOG_INFO, "mini-chat relay: stop requested")
end

function script_description()
  return "Starts the mini-chat chat relay with OBS and stops it when OBS closes.\n" ..
    "Pair and log in first (see relay\\README.md)."
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_bool(props, "auto_start", "Start the relay when OBS starts")
  obs.obs_properties_add_text(props, "node_path", "Node path (node.exe or a full path)", obs.OBS_TEXT_DEFAULT)
  obs.obs_properties_add_path(props, "relay_dir", "Relay folder (empty = this script's parent folder)", obs.OBS_PATH_DIRECTORY, nil, nil)
  obs.obs_properties_add_button(props, "start", "Start relay now", function() start_relay(); return false end)
  obs.obs_properties_add_button(props, "stop", "Stop relay", function() stop_relay(); return false end)
  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_bool(settings, "auto_start", true)
  obs.obs_data_set_default_string(settings, "node_path", "node.exe")
  obs.obs_data_set_default_string(settings, "relay_dir", "")
end

local function read_settings(settings)
  settings_auto = obs.obs_data_get_bool(settings, "auto_start")
  local node = obs.obs_data_get_string(settings, "node_path")
  settings_node = (node ~= nil and node ~= "") and node or "node.exe"
  settings_dir = obs.obs_data_get_string(settings, "relay_dir")
end

function script_update(settings)
  read_settings(settings)
end

local function on_event(event)
  if event == obs.OBS_FRONTEND_EVENT_EXIT and started then stop_relay() end
end

function script_load(settings)
  read_settings(settings)
  obs.obs_frontend_add_event_callback(on_event)
  -- "run" exits at once if a relay is already running, so a script reload is safe.
  if settings_auto then start_relay() end
end

function script_unload()
  if started then stop_relay() end
end
