namespace MediSeg.WPF.Models
{
    public class DicomMetadata
    {
        public string PatientName   { get; set; } = "Unknown";
        public string PatientId     { get; set; } = "";
        public string Modality      { get; set; } = "";
        public string StudyDesc     { get; set; } = "";
        public string SeriesDesc    { get; set; } = "";
        public DateTime? StudyDate  { get; set; }
        public int SliceCount       { get; set; }
        public double PixelSpacingX { get; set; } = 1.0;
        public double PixelSpacingY { get; set; } = 1.0;
        public double SliceThickness{ get; set; } = 1.0;
        public int Width            { get; set; }
        public int Height           { get; set; }
    }

    public class DicomSlice
    {
        public int    Index            { get; set; }
        public int    Width            { get; set; }
        public int    Height           { get; set; }
        public short[] PixelData       { get; set; } = Array.Empty<short>(); // HU values
        public double WindowCenter     { get; set; } = 40;
        public double WindowWidth      { get; set; } = 400;
        public double ImagePositionZ   { get; set; }
        public double PixelSpacingX    { get; set; } = 1.0;
        public double PixelSpacingY    { get; set; } = 1.0;
        public double SliceThickness   { get; set; } = 1.0;
        public string SopInstanceUid   { get; set; } = "";
    }
}
