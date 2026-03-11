/**
 * ASI Loader — инжектор ASI/DLL в gta_sa.exe (32-bit)
 * Использует 32-bit PowerShell для корректной работы с 32-bit процессом
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findProcessPid(processName) {
  try {
    const output = execSync(
      `tasklist /fi "imagename eq ${processName}" /fo csv /nh`,
      { encoding: 'utf8', windowsHide: true }
    );
    for (const line of output.trim().split('\n')) {
      if (line.toLowerCase().includes(processName.toLowerCase())) {
        const match = line.match(/"[^"]*","(\d+)"/);
        if (match) return parseInt(match[1]);
      }
    }
  } catch (e) {}
  return null;
}

async function waitForProcess(processName, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pid = findProcessPid(processName);
    if (pid) return pid;
    await sleep(500);
  }
  return null;
}

/**
 * Строит PowerShell-скрипт с C# кодом для инжекта
 * С retry-логикой и расширенной диагностикой
 */
function buildPsScript(pid, filePaths) {
  const pathsArray = filePaths
    .map((p) => "'" + p.replace(/'/g, "''") + "'")
    .join(',');

  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public class AsiInjector {
    const uint PROCESS_ALL_ACCESS = 0x001FFFFF;

    const uint MEM_COMMIT = 0x00001000;
    const uint MEM_RESERVE = 0x00002000;
    const uint PAGE_READWRITE = 0x04;
    const uint PAGE_EXECUTE_READWRITE = 0x40;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, uint dwSize, uint flAllocationType, uint flProtect);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, uint nSize, out int lpNumberOfBytesWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateRemoteThread(IntPtr hProcess, IntPtr lpThreadAttributes, uint dwStackSize, IntPtr lpStartAddress, IntPtr lpParameter, uint dwCreationFlags, out uint lpThreadId);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    public static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, uint dwSize, uint dwFreeType);

    static IntPtr TryOpenProcess(int pid, int maxRetries) {
        for (int i = 0; i < maxRetries; i++) {
            IntPtr h = OpenProcess(PROCESS_ALL_ACCESS, false, pid);
            if (h != IntPtr.Zero) return h;
            Thread.Sleep(1000);
        }
        return IntPtr.Zero;
    }

    static IntPtr TryAlloc(IntPtr hProcess, uint size, int maxRetries) {
        for (int i = 0; i < maxRetries; i++) {
            IntPtr mem = VirtualAllocEx(hProcess, IntPtr.Zero, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (mem != IntPtr.Zero) return mem;
            Thread.Sleep(500);
        }
        return IntPtr.Zero;
    }

    public static string Inject(int pid, string[] dllPaths) {
        StringBuilder sb = new StringBuilder();

        IntPtr hProcess = TryOpenProcess(pid, 5);
        if (hProcess == IntPtr.Zero) {
            int err = Marshal.GetLastWin32Error();
            return "FATAL:OpenProcess failed, error=" + err;
        }

        sb.AppendLine("OPEN|OK|handle=" + hProcess.ToInt64());

        IntPtr hKernel = GetModuleHandle("kernel32.dll");
        if (hKernel == IntPtr.Zero) {
            CloseHandle(hProcess);
            return "FATAL:GetModuleHandle kernel32 failed, error=" + Marshal.GetLastWin32Error();
        }

        IntPtr loadLibAddr = GetProcAddress(hKernel, "LoadLibraryA");
        if (loadLibAddr == IntPtr.Zero) {
            CloseHandle(hProcess);
            return "FATAL:GetProcAddress LoadLibraryA failed, error=" + Marshal.GetLastWin32Error();
        }

        sb.AppendLine("API|OK|LoadLibraryA=" + loadLibAddr.ToInt64().ToString("X"));

        foreach (string dllPath in dllPaths) {
            string fileName = Path.GetFileName(dllPath);

            try {
                byte[] pathBytes = Encoding.ASCII.GetBytes(dllPath + "\\0");
                uint bufLen = (uint)(dllPath.Length + 1);

                IntPtr remoteMem = TryAlloc(hProcess, bufLen + 16, 6);
                if (remoteMem == IntPtr.Zero) {
                    int err = Marshal.GetLastWin32Error();
                    sb.AppendLine(fileName + "|FAIL|VirtualAllocEx error=" + err);
                    continue;
                }

                int written;
                byte[] buffer = new byte[bufLen];
                Encoding.ASCII.GetBytes(dllPath, 0, dllPath.Length, buffer, 0);

                bool ok = WriteProcessMemory(hProcess, remoteMem, buffer, bufLen, out written);
                if (!ok) {
                    int err = Marshal.GetLastWin32Error();
                    sb.AppendLine(fileName + "|FAIL|WriteProcessMemory error=" + err);
                    continue;
                }

                uint threadId;
                IntPtr hThread = CreateRemoteThread(hProcess, IntPtr.Zero, 0, loadLibAddr, remoteMem, 0, out threadId);
                if (hThread == IntPtr.Zero) {
                    int err = Marshal.GetLastWin32Error();
                    sb.AppendLine(fileName + "|FAIL|CreateRemoteThread error=" + err);
                    continue;
                }

                WaitForSingleObject(hThread, 10000);
                CloseHandle(hThread);
                Thread.Sleep(300);

                sb.AppendLine(fileName + "|OK");
            } catch (Exception ex) {
                sb.AppendLine(fileName + "|FAIL|Exception: " + ex.Message);
            }
        }

        CloseHandle(hProcess);
        return sb.ToString().TrimEnd();
    }
}
"@

$result = [AsiInjector]::Inject(${pid}, @(${pathsArray}))
Write-Output $result
`;
}

/**
 * Инжектит все .asi и .dll файлы из папки {gamePath}/asi в процесс gta_sa.exe
 */
async function injectAsi(gamePath, onLog) {
  const log = onLog || console.log;

  const asiDir = path.join(gamePath, 'asi');
  if (!fs.existsSync(asiDir)) {
    throw new Error('Папка asi не найдена: ' + asiDir);
  }

  const files = fs.readdirSync(asiDir).filter((f) => /\.(asi|dll)$/i.test(f));
  if (files.length === 0) {
    throw new Error('В папке asi нет файлов .asi / .dll');
  }

  log('[ASI] Ожидание gta_sa.exe...');

  const pid = await waitForProcess('gta_sa.exe', 45000);
  if (!pid) {
    throw new Error('gta_sa.exe не найден (таймаут 45 сек)');
  }

  log(`[ASI] Найден gta_sa.exe (PID: ${pid}), ожидание полной загрузки...`);
  // Ждём 10 секунд чтобы процесс полностью инициализировался
  await sleep(10000);

  // Проверяем что процесс ещё жив
  const checkPid = findProcessPid('gta_sa.exe');
  if (!checkPid) {
    throw new Error('gta_sa.exe закрылся до начала инжекта');
  }

  const fullPaths = files.map((f) => path.resolve(asiDir, f));
  const script = buildPsScript(pid, fullPaths);

  const scriptPath = path.join(os.tmpdir(), `asi_inject_${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf-8');

  const ps32 = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'SysWOW64',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const psExe = fs.existsSync(ps32) ? ps32 : 'powershell.exe';

  let injected = 0;
  const errors = [];

  try {
    log('[ASI] Инжект через 32-bit процесс...');

    const output = execSync(
      `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf-8', windowsHide: true, timeout: 90000 }
    ).trim();

    console.log('[ASI RAW OUTPUT]', output);

    // Parse output
    if (output.startsWith('FATAL:')) {
      throw new Error(output);
    }

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split('|');
      const tag = parts[0];
      const status = parts[1];


      if (tag === 'OPEN' || tag === 'API') {
        log(`[ASI] ${tag}: ${parts.slice(1).join('|')}`);
        continue;
      }

      if (status === 'OK') {
        injected++;
        log(`[ASI] Загружен: ${tag}`);
      } else {
        const reason = parts.slice(2).join('|') || 'unknown';
        errors.push(`${tag}: ${reason}`);
        log(`[ASI] Ошибка: ${tag} — ${reason}`);
      }
    }
  } catch (e) {
    if (e.message.startsWith('FATAL:')) {
      throw e;
    }
    throw new Error('Ошибка инжекта: ' + e.message);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
  }

  log(`[ASI] Готово: ${injected}/${files.length} файлов загружено`);
  return { injected, total: files.length, errors };
}

module.exports = { injectAsi, findProcessPid, waitForProcess };
