using FellowOakDicom;
using FellowOakDicom.Imaging;
using FellowOakDicom.Imaging.Codec;
using MediSeg.WPF.Models;
using System.IO;

namespace MediSeg.WPF.Services
{
    /// <summary>
    /// fo-dicom을 이용해 DICOM 파일 목록을 로드하고 슬라이스 배열로 반환합니다.
    /// </summary>
    public class DicomLoaderService
    {
        private static readonly string[] _skipExts =
            { ".json", ".txt", ".xml", ".ds_store", ".ini", ".db" };

        // ── 파일 목록에서 DicomSlice 배열 로드 ──────────────────────────
        public async Task<(List<DicomSlice> slices, DicomMetadata meta)> LoadAsync(
            IEnumerable<string> filePaths,
            IProgress<int>? progress = null,
            CancellationToken ct = default)
        {
            var paths = filePaths
                .Where(p => !_skipExts.Contains(Path.GetExtension(p).ToLowerInvariant()))
                .ToList();

            if (paths.Count == 0)
                throw new InvalidOperationException("유효한 DICOM 파일이 없습니다.");

            // 1) 모든 파일 파싱 (병렬)
            var datasets = new List<(string path, DicomDataset ds)>();
            int loaded = 0;
            await Parallel.ForEachAsync(paths, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
                async (path, token) =>
                {
                    try
                    {
                        var file = await DicomFile.OpenAsync(path, FileReadOption.ReadAll).ConfigureAwait(false);
                        lock (datasets) datasets.Add((path, file.Dataset));
                    }
                    catch { /* 비-DICOM 파일 무시 */ }
                    finally
                    {
                        int n = Interlocked.Increment(ref loaded);
                        progress?.Report(n * 100 / paths.Count);
                    }
                });

            if (datasets.Count == 0)
                throw new InvalidOperationException("파싱 가능한 DICOM 파일이 없습니다.");

            // 2) ImagePositionPatient Z 값으로 정렬
            var sorted = datasets
                .Select(d => (d.path, d.ds, z: GetZ(d.ds)))
                .OrderBy(x => x.z)
                .ToList();

            // 3) 메타데이터 추출
            var firstDs = sorted[0].ds;
            var meta = ExtractMeta(firstDs, sorted.Count);

            // 4) 슬라이스 변환
            var slices = new List<DicomSlice>(sorted.Count);
            for (int i = 0; i < sorted.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var ds = sorted[i].ds;
                var slice = ExtractSlice(ds, i, sorted[i].z);
                slices.Add(slice);
            }

            return (slices, meta);
        }

        // ── 폴더 경로에서 로드 ────────────────────────────────────────────
        public Task<(List<DicomSlice> slices, DicomMetadata meta)> LoadFolderAsync(
            string folderPath,
            IProgress<int>? progress = null,
            CancellationToken ct = default)
        {
            var files = Directory.GetFiles(folderPath, "*", SearchOption.AllDirectories);
            return LoadAsync(files, progress, ct);
        }

        // ── 개별 슬라이스 픽셀 변환 ──────────────────────────────────────
        private static DicomSlice ExtractSlice(DicomDataset ds, int index, double z)
        {
            int w = ds.GetSingleValueOrDefault(DicomTag.Columns, (ushort)512);
            int h = ds.GetSingleValueOrDefault(DicomTag.Rows, (ushort)512);

            double rescaleSlope     = ds.GetSingleValueOrDefault(DicomTag.RescaleSlope,     1.0);
            double rescaleIntercept = ds.GetSingleValueOrDefault(DicomTag.RescaleIntercept, 0.0);
            double wc = ds.GetSingleValueOrDefault(DicomTag.WindowCenter, 40.0);
            double ww = ds.GetSingleValueOrDefault(DicomTag.WindowWidth,  400.0);

            // 픽셀 데이터를 short[] HU값으로 변환
            var rawElement = ds.GetDicomItem<DicomElement>(DicomTag.PixelData);
            short[] huValues = new short[w * h];

            if (rawElement is DicomOtherByte doB)
            {
                var raw = doB.Get<byte[]>();
                for (int i = 0; i < Math.Min(raw.Length / 2, huValues.Length); i++)
                {
                    short raw16 = BitConverter.ToInt16(raw, i * 2);
                    huValues[i] = (short)(raw16 * rescaleSlope + rescaleIntercept);
                }
            }
            else if (rawElement is DicomOtherWord doW)
            {
                var raw = doW.Get<ushort[]>();
                for (int i = 0; i < Math.Min(raw.Length, huValues.Length); i++)
                    huValues[i] = (short)((short)raw[i] * rescaleSlope + rescaleIntercept);
            }

            // PixelSpacing
            var ps = ds.GetValues<double>(DicomTag.PixelSpacing);
            double psx = ps != null && ps.Length >= 2 ? ps[1] : 1.0;
            double psy = ps != null && ps.Length >= 1 ? ps[0] : 1.0;
            double st  = ds.GetSingleValueOrDefault(DicomTag.SliceThickness, 1.0);

            return new DicomSlice
            {
                Index          = index,
                Width          = w,
                Height         = h,
                PixelData      = huValues,
                WindowCenter   = wc,
                WindowWidth    = ww,
                ImagePositionZ = z,
                PixelSpacingX  = psx,
                PixelSpacingY  = psy,
                SliceThickness = st,
                SopInstanceUid = ds.GetSingleValueOrDefault(DicomTag.SOPInstanceUID, "")
            };
        }

        private static double GetZ(DicomDataset ds)
        {
            try
            {
                var ipp = ds.GetValues<double>(DicomTag.ImagePositionPatient);
                return ipp != null && ipp.Length >= 3 ? ipp[2] : 0.0;
            }
            catch { return 0.0; }
        }

        private static DicomMetadata ExtractMeta(DicomDataset ds, int sliceCount)
        {
            var ps = ds.GetValues<double>(DicomTag.PixelSpacing);
            return new DicomMetadata
            {
                PatientName    = ds.GetSingleValueOrDefault(DicomTag.PatientName, "Unknown").ToString(),
                PatientId      = ds.GetSingleValueOrDefault(DicomTag.PatientID, ""),
                Modality       = ds.GetSingleValueOrDefault(DicomTag.Modality, ""),
                StudyDesc      = ds.GetSingleValueOrDefault(DicomTag.StudyDescription, ""),
                SeriesDesc     = ds.GetSingleValueOrDefault(DicomTag.SeriesDescription, ""),
                SliceCount     = sliceCount,
                Width          = ds.GetSingleValueOrDefault(DicomTag.Columns, (ushort)512),
                Height         = ds.GetSingleValueOrDefault(DicomTag.Rows,    (ushort)512),
                PixelSpacingX  = ps != null && ps.Length >= 2 ? ps[1] : 1.0,
                PixelSpacingY  = ps != null && ps.Length >= 1 ? ps[0] : 1.0,
                SliceThickness = ds.GetSingleValueOrDefault(DicomTag.SliceThickness, 1.0),
            };
        }
    }
}
