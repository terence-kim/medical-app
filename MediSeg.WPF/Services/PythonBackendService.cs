using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace MediSeg.WPF.Services
{
    /// <summary>
    /// Python AI 세그멘테이션 백엔드(pipeline.py)를 subprocess로 실행합니다.
    /// </summary>
    public class PythonBackendService
    {
        private readonly string _pythonBackendDir;
        private string _pythonExe = "python";

        public PythonBackendService(string projectRoot)
        {
            _pythonBackendDir = Path.Combine(projectRoot, "python_backend");
            DetectPython();
        }

        private void DetectPython()
        {
            // venv 우선 탐색
            var venvPy = Path.Combine(_pythonBackendDir, "..", ".venv", "Scripts", "python.exe");
            if (File.Exists(venvPy)) { _pythonExe = Path.GetFullPath(venvPy); return; }
            var condaPy = Path.Combine(_pythonBackendDir, "..", "env", "Scripts", "python.exe");
            if (File.Exists(condaPy)) { _pythonExe = Path.GetFullPath(condaPy); return; }
        }

        /// <summary>
        /// 지정 DICOM 폴더에 대해 AI 세그멘테이션을 실행하고 NIfTI labelmap 경로를 반환합니다.
        /// </summary>
        public async Task<string?> RunSegmentationAsync(
            string dicomFolder,
            IProgress<string>? statusProgress = null,
            CancellationToken ct = default)
        {
            var outputDir = Path.Combine(dicomFolder, "_seg_output");
            Directory.CreateDirectory(outputDir);

            var psi = new ProcessStartInfo
            {
                FileName               = _pythonExe,
                Arguments              = $"\"{Path.Combine(_pythonBackendDir, "pipeline.py")}\" --input \"{dicomFolder}\" --output \"{outputDir}\"",
                WorkingDirectory       = _pythonBackendDir,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true
            };

            using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };

            var tcs = new TaskCompletionSource<int>();
            proc.Exited += (_, _) => tcs.TrySetResult(proc.ExitCode);

            proc.OutputDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data)) statusProgress?.Report(e.Data);
            };
            proc.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data)) statusProgress?.Report($"[ERR] {e.Data}");
            };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            using (ct.Register(() => { try { proc.Kill(); } catch { } }))
                await tcs.Task.ConfigureAwait(false);

            // 결과 NIfTI 파일 찾기
            var nifti = Directory.GetFiles(outputDir, "*.nii.gz").FirstOrDefault()
                     ?? Directory.GetFiles(outputDir, "*.nii").FirstOrDefault();
            return nifti;
        }

        /// <summary>
        /// Python 환경에 필요한 패키지가 설치되어 있는지 확인합니다.
        /// </summary>
        public async Task<bool> CheckEnvironmentAsync()
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName               = _pythonExe,
                    Arguments              = "-c \"import monai; import torch; print('OK')\"",
                    RedirectStandardOutput = true,
                    UseShellExecute        = false,
                    CreateNoWindow         = true
                };
                using var proc = Process.Start(psi)!;
                string output = await proc.StandardOutput.ReadToEndAsync();
                await proc.WaitForExitAsync();
                return output.Trim() == "OK";
            }
            catch { return false; }
        }
    }
}
