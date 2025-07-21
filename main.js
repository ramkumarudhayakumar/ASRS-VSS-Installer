const { app, BrowserWindow, ipcMain, shell} = require("electron")
const path = require("path")
const { spawn, exec } = require("child_process")
const fs = require("fs")
const os = require("os")
const wifi = require("node-wifi")

let mainWindow
let pythonProcess
console.log("Path:", path.join(__dirname))
console.log("Resources Path (Dev):", process.resourcesPath)

// Initialize node-wifi
wifi.init({
  iface: null, // network interface, set to null to use default
})

app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication")

const isDev = !app.isPackaged

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    // frame: false,
    // fullscreen:true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev, // Only enable devTools in development
      // devTools: true,
      webSecurity: false,
      preload: path.join(__dirname, "../preload/preload.js"),
    },
    icon: path.join(__dirname, "../assets/icon.ico"),
  })

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173")
    mainWindow.webContents.openDevTools()
  } else {
    const indexPath = path.join(__dirname, "../frontend/dist/index.html")
    // mainWindow.loadURL(`file://${indexPath}`)
    mainWindow.loadFile(indexPath)
    // mainWindow.webContents.openDevTools()
  }

  mainWindow.setMenu(null)

  mainWindow.on("closed", () => {
    console.log("🪟 Main window closed")
    mainWindow = null
    // Ensure app quits when main window is closed
    if (process.platform !== "darwin") {
      gracefulShutdown()
    }
  })

  // Handle window close event
  mainWindow.on("close", (event) => {
    console.log("🪟 Main window closing...")
    // Don't prevent close, let it happen naturally
  })
}

// Enhanced logging setup
let logStream = null
const logDir = isDev ? path.join(__dirname, "../logs") : path.join(process.resourcesPath, "logs")

function setupLogging() {
  try {
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    // Create log file with current date
    const today = new Date().toISOString().split("T")[0] // YYYY-MM-DD format
    const logFileName = `log-${today}.txt`
    const logFilePath = path.join(logDir, logFileName)

    // Create write stream for logging
    logStream = fs.createWriteStream(logFilePath, { flags: "a" })

    // Override console.log to write to both console and file
    const originalConsoleLog = console.log
    const originalConsoleError = console.error

    console.log = (...args) => {
      const timestamp = new Date().toISOString()
      const message = `[${timestamp}] LOG: ${args.join(" ")}`
      originalConsoleLog(...args)
      if (logStream) {
        logStream.write(message + "\n")
      }
    }

    console.error = (...args) => {
      const timestamp = new Date().toISOString()
      const message = `[${timestamp}] ERROR: ${args.join(" ")}`
      originalConsoleError(...args)
      if (logStream) {
        logStream.write(message + "\n")
      }
    }

    console.log("📝 Logging system initialized:", logFilePath)
  } catch (error) {
    console.error("Failed to setup logging:", error)
  }
}

function startBackend() {
  let backendPath
  let pythonCmd

  if (isDev) {
    backendPath = path.join(__dirname, "../backend/app.py")
    pythonCmd = process.platform === "win32" ? "python" : "python3"
  } else {
    // Production build - try multiple possible paths
    const possiblePaths = [
      path.join(process.resourcesPath, "backend", "app.py"),
      path.join(process.resourcesPath, "app", "backend", "app.py"),
      path.join(__dirname, "../backend/app.py"),
      path.join(app.getAppPath(), "backend", "app.py"),
    ]

    backendPath = possiblePaths.find((p) => fs.existsSync(p))

    if (!backendPath) {
      console.error("Python backend not found in any expected location:")
      possiblePaths.forEach((p) => console.error(`  - ${p}`))
      return
    }

    // Try different Python commands for production
    const pythonCommands = ["python", "python3", "py"]
    pythonCmd = pythonCommands[0] // Default to first, will validate below
  }

  console.log("Starting Python backend:", backendPath)
  console.log("Using Python command:", pythonCmd)
  console.log("Working directory:", process.cwd())
  console.log("Resources path:", process.resourcesPath)

  // Validate Python installation
  exec(`${pythonCmd} --version`, (error, stdout, stderr) => {
    if (error) {
      console.error("Python validation failed:", error.message)
      // Try alternative Python commands in production
      if (!isDev) {
        const altCommands = ["python3", "py", "python"]
        for (const cmd of altCommands) {
          if (cmd !== pythonCmd) {
            console.log(`Trying alternative Python command: ${cmd}`)
            startPythonProcess(cmd, backendPath)
            return
          }
        }
      }
    } else {
      console.log("Python version:", stdout.trim())
      startPythonProcess(pythonCmd, backendPath)
    }
  })
}

function startPythonProcess(pythonCmd, backendPath) {
  pythonProcess = spawn(pythonCmd, [backendPath], {
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: path.dirname(backendPath), // Set working directory to backend folder
    env: { ...process.env, PYTHONPATH: path.dirname(backendPath) },
  })

  pythonProcess.stdout.on("data", (data) => {
    console.log(`Python stdout: ${data.toString().trim()}`)
  })

  pythonProcess.stderr.on("data", (data) => {
    const errorMsg = data.toString().trim()
    console.error(`Python stderr: ${errorMsg}`)

    if (errorMsg.includes("No such file") || errorMsg.includes("not recognized")) {
      console.error("Python script not found or Python is not installed properly.")
    } else if (errorMsg.includes("ModuleNotFoundError")) {
      console.error("Python module missing. Please install required dependencies.")
    } else if (errorMsg.includes("Permission denied")) {
      console.error("Permission denied accessing Python script.")
    }
  })

  pythonProcess.on("close", (code) => {
    console.log(`Python backend exited with code ${code}`)
    pythonProcess = null

    // Attempt restart if exit was unexpected (not during shutdown)
    if (code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      console.log("Attempting to restart Python backend in 5 seconds...")
      setTimeout(() => {
        if (!pythonProcess) {
          startBackend()
        }
      }, 5000)
    }
  })

  pythonProcess.on("error", (error) => {
    console.error("Failed to start Python backend:", error.message)
    pythonProcess = null
  })

  // Test backend connection after startup
  setTimeout(() => {
    testBackendConnection()
  }, 3000)
}

function testBackendConnection() {
  const http = require("http")
  const options = {
    hostname: "localhost",
    port: 5000, // Adjust if your backend uses a different port
    path: "/health", // Add a health check endpoint to your Python API
    method: "GET",
    timeout: 5000,
  }

  const req = http.request(options, (res) => {
    console.log(`Backend health check: ${res.statusCode}`)
    if (res.statusCode === 200) {
      console.log("Python backend is running and accessible")
    }
  })

  req.on("error", (error) => {
    console.error("Backend connection test failed:", error.message)
  })

  req.on("timeout", () => {
    console.error("Backend connection test timed out")
    req.destroy()
  })

  req.end()
}

function gracefulShutdown() {
  console.log("Starting graceful shutdown...")

  // Close log stream
  if (logStream) {
    logStream.end()
    logStream = null
  }

  // Kill Python process if it exists
  if (pythonProcess && !pythonProcess.killed) {
    console.log("Terminating Python backend...")
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", pythonProcess.pid, "/f", "/t"])
      } else {
        pythonProcess.kill("SIGTERM")
      }
    } catch (error) {
      console.error("Error killing Python process:", error)
    }
    pythonProcess = null
  }

  // Close main window if it exists
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log("🪟 Closing main window...")
    mainWindow.close()
    mainWindow = null
  }

  console.log("Graceful shutdown complete")
}

app.whenReady().then(() => {
  console.log("Electron app ready")
  setupLogging()
  createWindow()
  startBackend()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

const nircmdPath = `"${path.join(__dirname, "nircmd.exe")}"`

// Handle get system volume request
ipcMain.handle("get-system-volume", async () => {
  console.log("Received get-system-volume request from renderer")
  const platform = os.platform()
  try {
    let command = ""
    switch (platform) {
      // case "win32": // Windows
      //   // Requires nircmd.exe to be available in PATH or bundled.
      //   // nircmd.exe getsysvolume returns: current_volume_0_65535 current_mute_status_0_1
      //   command = `${nircmdPath} getsysvolume`
      //   break
      case "win32": {
        return new Promise((resolve) => {
          const nircmdExePath = path.join(__dirname, "nircmd.exe")
          const child = spawn(nircmdExePath, ["getsysvolume"], {
            windowsHide: true,
          })

          let output = ""
          child.stdout.on("data", (data) => {
            output += data.toString()
          })

          child.stderr.on("data", (data) => {
            console.error("NirCmd stderr:", data.toString())
          })

          child.on("close", (code) => {
            if (code !== 0) {
              return resolve({ success: false, error: "NirCmd exited with code " + code })
            }
            try {
              const parts = output.trim().split(" ")
              let volume = 0
              let isMuted = false
              if (parts.length >= 1) {
                volume = Math.round((parseInt(parts[0]) / 65535) * 100)
              }
              // Optional: check mute status using "getappvolume" or a separate command
              resolve({ success: true, volume, isMuted })
            } catch (err) {
              resolve({ success: false, error: "Failed to parse volume output" })
            }
          })
        })
      }
      case "darwin": // macOS
        // osascript -e 'get volume settings' returns: {output volume:50, output muted:false, input volume:50, alert volume:100}
        command = "osascript -e 'get volume settings'"
        break
      case "linux": // Linux (using pactl for PulseAudio, common on modern Linux)
        // pactl list sinks | grep 'Volume:' | head -n 1
        command = "pactl list sinks | grep 'Volume:' | head -n 1"
        break
      default:
        return { success: false, error: `Unsupported platform for volume control: ${platform}` }
    }

    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error getting system volume on ${platform}:`, error.message)
          resolve({ success: false, error: error.message })
          return
        }
        if (stderr) {
          console.error(`Stderr getting system volume on ${platform}:`, stderr)
          resolve({ success: false, error: stderr })
          return
        }

        let volume = 0
        let isMuted = false

        if (platform === "win32") {
          const parts = stdout.trim().split(" ")
          if (parts.length >= 2) {
            volume = Math.round((Number.parseInt(parts[0]) / 65535) * 100)
            isMuted = Number.parseInt(parts[1]) === 1
          }
        } else if (platform === "darwin") {
          const match = stdout.match(/output volume:(\d+), output muted:(true|false)/)
          if (match) {
            volume = Number.parseInt(match[1])
            isMuted = match[2] === "true"
          }
        } else if (platform === "linux") {
          const match = stdout.match(/Volume:.*?(\d+)%/i)
          if (match) {
            volume = Number.parseInt(match[1])
          }
          // Check mute status for Linux (requires separate command or more complex parsing)
          exec("pactl list sinks | grep 'Mute:' | head -n 1", (muteError, muteStdout) => {
            if (!muteError && muteStdout) {
              isMuted = muteStdout.includes("yes")
            }
            resolve({ success: true, volume, isMuted })
          })
          return // Resolve inside the nested exec for Linux mute check
        }
        resolve({ success: true, volume, isMuted })
      })
    })
  } catch (error) {
    console.error("Unexpected error in get-system-volume:", error)
    return { success: false, error: error.message }
  }
})

// Handle set system volume request
ipcMain.handle("set-system-volume", async (event, newVolume) => {
  console.log(`Received set-system-volume request: ${newVolume}%`)
  const platform = os.platform()
  try {
    let command = ""
    switch (platform) {
      case "win32": // Windows
        // nircmd.exe setsysvolume <volume_level_0_65535>
        const winVolume = Math.round((newVolume / 100) * 65535)
        command = `${nircmdPath} setsysvolume ${winVolume}`
        break
      case "darwin": // macOS
        // osascript -e 'set volume output volume <volume_percentage>'
        command = `osascript -e 'set volume output volume ${newVolume}'`
        break
      case "linux": // Linux (using pactl for PulseAudio)
        // pactl set-sink-volume @DEFAULT_SINK@ <volume_percentage>%
        command = `pactl set-sink-volume @DEFAULT_SINK@ ${newVolume}%`
        break
      default:
        return { success: false, error: `Unsupported platform for volume control: ${platform}` }
    }

    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          // console.error(`Error setting system volume on ${platform}:`, error.message)
          resolve({ success: false, error: error.message })
        } else if (stderr) {
          // console.error(`Stderr setting system volume on ${platform}:`, stderr)
          resolve({ success: false, error: stderr })
        } else {
          // console.log(`System volume set to ${newVolume}% on ${platform}`)
          resolve({ success: true })
        }
      })
    })
  } catch (error) {
    console.error("Unexpected error in set-system-volume:", error)
    return { success: false, error: error.message }
  }
})

// Handle toggle mute request
ipcMain.handle("toggle-mute", async () => {
  console.log("Received toggle-mute request from renderer")
  const platform = os.platform()
  try {
    let command = ""
    switch (platform) {
      case "win32": // Windows
        // nircmd.exe mutesysvolume 2 (toggles mute)
        command = `${nircmdPath} mutesysvolume 2`
        break
      case "darwin": // macOS
        // osascript -e 'set volume output muted (not (output muted of (get volume settings)))'
        command = "osascript -e 'set volume output muted (not (output muted of (get volume settings)))'"
        break
      case "linux": // Linux (using pactl for PulseAudio)
        // pactl set-sink-mute @DEFAULT_SINK@ toggle
        command = "pactl set-sink-mute @DEFAULT_SINK@ toggle"
        break
      default:
        return { success: false, error: `Unsupported platform for mute control: ${platform}` }
    }

    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          // console.error(`Error toggling mute on ${platform}:`, error.message)
          resolve({ success: false, error: error.message })
        } else if (stderr) {
          // console.error(`Stderr toggling mute on ${platform}:`, stderr)
          resolve({ success: false, error: stderr })
        } else {
          // console.log(`System mute toggled on ${platform}`)
          resolve({ success: true })
        }
      })
    })
  } catch (error) {
    console.error("Unexpected error in toggle-mute:", error)
    return { success: false, error: error.message }
  }
})

// Handle Wi-Fi scan request
ipcMain.handle("scan-wifi", async () => {
  // console.log("Received scan-wifi request from renderer")
  try {
    const networks = await wifi.scan()
    // console.log("Wi-Fi scan successful:", networks.length, "networks found")
    return { success: true, networks }
  } catch (error) {
    // console.error("Error scanning Wi-Fi:", error.message)
    return { success: false, error: error.message }
  }
})

// Handle Wi-Fi connection request
ipcMain.handle("connect-wifi", async (event, { ssid, password, autoConnect }) => {
  // console.log(`Received connect-wifi request for SSID: ${ssid}`)
  try {
    // await wifi.connect({ ssid, password })
    await wifi.connect({ ssid, password, hidden: true });
    // console.log(`Successfully connected to Wi-Fi: ${ssid}`)
    return { success: true, message: `Connected to ${ssid}` }
  } catch (error) {
    // console.error(`Error connecting to Wi-Fi ${ssid}:`, error.message)
    return { success: false, error: error.message }
  }
})

// Handle Wi-Fi disconnect request
ipcMain.handle("disconnect-wifi", async () => {
  // console.log("Received disconnect-wifi request from renderer")
  try {
    await wifi.disconnect()
    // console.log("Successfully disconnected from Wi-Fi")
    return { success: true, message: "Disconnected from Wi-Fi" }
  } catch (error) {
    // console.error("Error disconnecting from Wi-Fi:", error.message)
    return { success: false, error: error.message }
  }
})

// Handle get current Wi-Fi connection request
ipcMain.handle("get-current-wifi-connection", async () => {
  // console.log("Received get-current-wifi-connection request from renderer")
  try {
    const connection = await wifi.getCurrentConnections()
    if (connection && connection.length > 0) {
      // console.log("Current Wi-Fi connection:", connection[0].ssid)
      return { success: true, connection: connection[0] }
    } else {
      // console.log("Not currently connected to any Wi-Fi network.")
      return { success: true, connection: null }
    }
  } catch (error) {
    // console.error("Error getting current Wi-Fi connection:", error.message)
    return { success: false, error: error.message }
  }
})

// Handle get network interfaces (for wired LAN check)
ipcMain.handle("get-network-interfaces", async () => {
  // console.log("Received get-network-interfaces request from renderer")
  try {
    const interfaces = os.networkInterfaces()
    const activeInterfaces = {}
    let wiredLanDetected = false

    for (const ifaceName in interfaces) {
      const ifaceDetails = interfaces[ifaceName]
      const isWired =
        ifaceName.toLowerCase().includes("eth") ||
        ifaceName.toLowerCase().includes("en") ||
        ifaceName.toLowerCase().includes("ethernet") ||
        ifaceName.toLowerCase().includes("lan")

      for (const detail of ifaceDetails) {
        // Check for IPv4, not internal (loopback), and has an address
        if (detail.family === "IPv4" && !detail.internal && detail.address) {
          if (!activeInterfaces[ifaceName]) {
            activeInterfaces[ifaceName] = {
              name: ifaceName,
              isWired: isWired,
              isUp: true, // If it has an IP, it's considered up
              ipAddress: detail.address,
              mac: detail.mac,
            }
          }
          if (isWired) {
            wiredLanDetected = true
          }
        }
      }
    }
    // console.log("Network interfaces retrieved. Wired LAN detected:", wiredLanDetected)
    return { success: true, activeInterfaces: Object.values(activeInterfaces), wiredLanDetected }
  } catch (error) {
    // console.error("Error getting network interfaces:", error.message)
    return { success: false, error: error.message }
  }
})

// New IPC handler for opening external links
ipcMain.handle("open-external-link", async (event, url) => {
  console.log(`Received open-external-link request for URL: ${url}`);
  try {
    await shell.openExternal(url);
    console.log(`Successfully opened external link: ${url}`);
    return { success: true };
  } catch (error) {
    console.error(`Error opening external link ${url}:`, error.message);
    return { success: false, error: error.message };
  }
});


app.on("window-all-closed", () => {
  console.log("🪟 All windows closed")
  gracefulShutdown()
  app.quit()
})

app.on("before-quit", (event) => {
  console.log("App before-quit event")
  gracefulShutdown()
})

app.on("will-quit", (event) => {
  console.log("App will-quit event")
})

app.on("quit", () => {
  console.log("App quit event")
})

// Handle IPC messages from renderer
ipcMain.on("app-quit", (event) => {
  console.log("Received app-quit signal from renderer")

  // Send acknowledgment back to renderer
  if (event.sender && !event.sender.isDestroyed()) {
    event.sender.send("app-quit-acknowledged")
  }

  // Force quit after a short delay to ensure cleanup
  setTimeout(() => {
    console.log("Force quitting application...")
    gracefulShutdown()
    app.quit()

    // If app.quit() doesn't work, force exit
    setTimeout(() => {
      console.log("Force exiting process...")
      process.exit(0)
    }, 1000)
  }, 500)
})

// Handle force quit request
ipcMain.on("app-force-quit", (event) => {
  console.log("Received app-force-quit signal from renderer")

  gracefulShutdown()

  // Immediate force quit
  setTimeout(() => {
    process.exit(0)
  }, 100)
})

// Handle app status requests
ipcMain.handle("app-get-status", () => {
  const packageJsonPath = path.join(app.getAppPath(), 'package.json');
  let appType = 'Unknown';
  let machineType = 'Unknown';
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    appType = packageJson.appType || 'Unknown';
    machineType = packageJson.machineType || 'Unknown';
  } catch (error){
    console.error("Failed to read appType from package.json:", error);
    
}
  return {
    isElectron: true,
    isDev: isDev,
    platform: process.platform,
    version: app.getVersion(),
    appType: appType,
    machineType: machineType,
  }
})

// Handle shutdown request
ipcMain.handle("app-shutdown", () => {
  console.log("🔌 Shutdown requested from renderer")

  return new Promise((resolve, reject) => {
    try {
      const platform = process.platform
      let command = ""

      switch (platform) {
        case "win32": // Windows
          command = "shutdown /s /t 0"
          break
        case "darwin": // macOS
          command = "osascript -e 'tell app \"System Events\" to shut down'"
          break
        case "linux": // Linux
          command = "shutdown now"
          break
        default:
          reject(new Error(`Unsupported platform: ${platform}`))
          return
      }

      console.log(`🔌 Executing shutdown command: ${command}`)
      exec(command, (error) => {
        if (error) {
          console.error("Shutdown command failed:", error)
          reject(error)
        } else {
          console.log("Shutdown command executed successfully")
          resolve(true)
        }
      })
    } catch (error) {
      console.error("Error executing shutdown command:", error)
      reject(error)
    }
  })
})

// Handle restart request
ipcMain.handle("app-restart", () => {
  console.log("Restart requested from renderer")

  return new Promise((resolve, reject) => {
    try {
      const platform = process.platform
      let command = ""

      switch (platform) {
        case "win32": // Windows
          command = "shutdown /r /t 0"
          break
        case "darwin": // macOS
          command = "osascript -e 'tell app \"System Events\" to restart'"
          break
        case "linux": // Linux
          command = "shutdown -r now"
          break
        default:
          reject(new Error(`Unsupported platform: ${platform}`))
          return
      }

      console.log(`Executing restart command: ${command}`)
      exec(command, (error) => {
        if (error) {
          console.error("Restart command failed:", error)
          reject(error)
        } else {
          console.log("Restart command executed successfully")
          resolve(true)
        }
      })
    } catch (error) {
      console.error("Error executing restart command:", error)
      reject(error)
    }
  })
})

// Handle sleep request
ipcMain.handle("app-sleep", () => {
  console.log("💤 Sleep requested from renderer")
  return new Promise((resolve, reject) => {
    try {
      const platform = process.platform
      let command = ""
      switch (platform) {
        case "win32": // Windows
          // rundll32.exe powrprof.dll,SetSuspendState 0,1,0 (Hibernate: 0, Suspend: 1, Force: 0)
          command = "rundll32.exe powrprof.dll,SetSuspendState 0,1,0"
          break
        case "darwin": // macOS
          command = "pmset sleepnow"
          break
        case "linux": // Linux
          command = "systemctl suspend"
          break
        default:
          reject(new Error(`Unsupported platform: ${platform}`))
          return
      }
      console.log(`💤 Executing sleep command: ${command}`)
      exec(command, (error) => {
        if (error) {
          console.error("Sleep command failed:", error)
          reject(error)
        } else {
          console.log("Sleep command executed successfully")
          resolve(true)
        }
      })
    } catch (error) {
      console.error("Error executing sleep command:", error)
      reject(error)
    }
  })
})

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  console.log("Another instance is already running. Quitting...")
  app.quit()
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error)
  gracefulShutdown()
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
})
