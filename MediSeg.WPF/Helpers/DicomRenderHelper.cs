using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace MediSeg.WPF.Helpers
{
    /// <summary>
    /// DICOM HU 픽셀 데이터를 WPF WriteableBitmap으로 변환 (Window/Level 적용)
    /// </summary>
    public static class DicomRenderHelper
    {
        // ── 슬라이스를 그레이스케일 WriteableBitmap으로 렌더링 ────────────
        public static WriteableBitmap RenderSlice(
            short[] huData, int width, int height,
            double windowCenter, double windowWidth)
        {
            var wb = new WriteableBitmap(width, height, 96, 96, PixelFormats.Bgr32, null);
            UpdateSlice(wb, huData, width, height, windowCenter, windowWidth);
            return wb;
        }

        public static unsafe void UpdateSlice(
            WriteableBitmap wb,
            short[] huData, int width, int height,
            double windowCenter, double windowWidth,
            byte[]? labelmap = null,
            byte[]? visibleLabels = null,
            (byte r, byte g, byte b, byte a)[]? labelColors = null,
            int sliceOffset = 0)
        {
            wb.Lock();
            int* ptr = (int*)wb.BackBuffer.ToPointer();
            int stride = wb.BackBufferStride / 4;

            double lo = windowCenter - windowWidth / 2.0;
            double hi = windowCenter + windowWidth / 2.0;

            for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int idx = y * width + x;
                double hu = idx < huData.Length ? huData[idx] : 0;

                // Window/Level → 0~255 그레이
                byte gray;
                if (hu <= lo)       gray = 0;
                else if (hu >= hi)  gray = 255;
                else                gray = (byte)((hu - lo) / windowWidth * 255.0);

                int color = (gray << 16) | (gray << 8) | gray; // BGR32

                // 세그멘테이션 오버레이
                if (labelmap != null && visibleLabels != null && labelColors != null)
                {
                    int labIdx = sliceOffset + idx;
                    if (labIdx < labelmap.Length)
                    {
                        byte lab = labelmap[labIdx];
                        if (lab > 0 && visibleLabels.Contains(lab))
                        {
                            var (r, g, b, a) = labelColors[lab];
                            float alpha = a / 255f * 0.55f;
                            int br = (int)(gray * (1 - alpha) + r * alpha);
                            int bg = (int)(gray * (1 - alpha) + g * alpha);
                            int bb = (int)(gray * (1 - alpha) + b * alpha);
                            color = (Math.Clamp(br,0,255) << 16) |
                                    (Math.Clamp(bg,0,255) << 8)  |
                                     Math.Clamp(bb,0,255);
                        }
                    }
                }

                ptr[y * stride + x] = color;
            }

            wb.AddDirtyRect(new Int32Rect(0, 0, width, height));
            wb.Unlock();
        }

        // ── HU 범위를 초록색으로 미리보기 (Gate Preview) ─────────────────
        public static unsafe void ApplyGatePreview(
            WriteableBitmap wb,
            short[] huData, int width, int height,
            double windowCenter, double windowWidth,
            int huMin, int huMax)
        {
            wb.Lock();
            int* ptr = (int*)wb.BackBuffer.ToPointer();
            int stride = wb.BackBufferStride / 4;

            double lo = windowCenter - windowWidth / 2.0;
            double hi = windowCenter + windowWidth / 2.0;

            for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int idx = y * width + x;
                double hu = idx < huData.Length ? huData[idx] : 0;

                byte gray;
                if (hu <= lo)       gray = 0;
                else if (hu >= hi)  gray = 255;
                else                gray = (byte)((hu - lo) / windowWidth * 255.0);

                int color;
                if (hu >= huMin && hu <= huMax)
                    // 초록색 하이라이트
                    color = (0 << 16) | (Math.Clamp((int)(gray * 0.6 + 100), 0, 255) << 8) | 0;
                else
                    color = (gray << 16) | (gray << 8) | gray;

                ptr[y * stride + x] = color;
            }

            wb.AddDirtyRect(new Int32Rect(0, 0, width, height));
            wb.Unlock();
        }

        // ── MPR용: 볼륨에서 특정 축 슬라이스 추출 ───────────────────────
        public static WriteableBitmap RenderMprSlice(
            short[] volume, int volW, int volH, int volD,
            string plane, int sliceIdx,
            double windowCenter, double windowWidth)
        {
            int outW, outH;
            Func<int, int, short> sampler;

            switch (plane)
            {
                case "sagittal": // YZ plane, X=fixed
                    outW = volH; outH = volD;
                    sampler = (x, y) =>
                    {
                        int vx = sliceIdx, vy = x, vz = y;
                        if (vx < 0 || vx >= volW || vy < 0 || vy >= volH || vz < 0 || vz >= volD) return 0;
                        return volume[vz * volW * volH + vy * volW + vx];
                    };
                    break;
                case "coronal": // XZ plane, Y=fixed
                    outW = volW; outH = volD;
                    sampler = (x, y) =>
                    {
                        int vx = x, vy = sliceIdx, vz = y;
                        if (vx < 0 || vx >= volW || vy < 0 || vy >= volH || vz < 0 || vz >= volD) return 0;
                        return volume[vz * volW * volH + vy * volW + vx];
                    };
                    break;
                default: // axial: XY plane, Z=fixed
                    outW = volW; outH = volH;
                    sampler = (x, y) =>
                    {
                        int vx = x, vy = y, vz = sliceIdx;
                        if (vx < 0 || vx >= volW || vy < 0 || vy >= volH || vz < 0 || vz >= volD) return 0;
                        return volume[vz * volW * volH + vy * volW + vx];
                    };
                    break;
            }

            var wb = new WriteableBitmap(outW, outH, 96, 96, PixelFormats.Bgr32, null);
            unsafe
            {
                wb.Lock();
                int* ptr = (int*)wb.BackBuffer.ToPointer();
                int stride = wb.BackBufferStride / 4;
                double lo = windowCenter - windowWidth / 2.0;
                double hi = windowCenter + windowWidth / 2.0;

                for (int y = 0; y < outH; y++)
                for (int x = 0; x < outW; x++)
                {
                    double hu = sampler(x, y);
                    byte gray;
                    if (hu <= lo)       gray = 0;
                    else if (hu >= hi)  gray = 255;
                    else                gray = (byte)((hu - lo) / windowWidth * 255.0);
                    ptr[y * stride + x] = (gray << 16) | (gray << 8) | gray;
                }

                wb.AddDirtyRect(new Int32Rect(0, 0, outW, outH));
                wb.Unlock();
            }
            return wb;
        }
    }
}
