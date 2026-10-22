using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;

namespace MediSeg.WPF.Models
{
    public partial class Mask : ObservableObject
    {
        [ObservableProperty] private string _id = "";
        [ObservableProperty] private string _label = "";
        [ObservableProperty] private Color _color;
        [ObservableProperty] private bool _visible = true;
        [ObservableProperty] private int _huMin;
        [ObservableProperty] private int _huMax;
        [ObservableProperty] private bool _isActive;

        public byte ColorIndex { get; set; }  // 1-based index in labelmap (0 = background)
    }

    public static class DefaultMasks
    {
        public static List<Mask> Create() => new()
        {
            new Mask { Id = "bone",     Label = "Bone",       Color = Color.FromRgb(255,235,186), HuMin = 400,  HuMax = 3000, ColorIndex = 1 },
            new Mask { Id = "liver",    Label = "Liver",      Color = Color.FromRgb(255,120, 60), HuMin = 40,   HuMax = 80,   ColorIndex = 2 },
            new Mask { Id = "kidney",   Label = "Kidney",     Color = Color.FromRgb(255, 60,120), HuMin = 20,   HuMax = 80,   ColorIndex = 3 },
            new Mask { Id = "lung",     Label = "Lung",       Color = Color.FromRgb(100,200,255), HuMin = -900, HuMax = -400, ColorIndex = 4 },
            new Mask { Id = "muscle",   Label = "Muscle",     Color = Color.FromRgb(255,200, 80), HuMin = 10,   HuMax = 80,   ColorIndex = 5 },
            new Mask { Id = "fat",      Label = "Fat",        Color = Color.FromRgb(220,180, 80), HuMin = -150, HuMax = -50,  ColorIndex = 6 },
            new Mask { Id = "vessel",   Label = "Vessel",     Color = Color.FromRgb(220, 80, 80), HuMin = 100,  HuMax = 400,  ColorIndex = 7 },
            new Mask { Id = "custom",   Label = "Custom",     Color = Color.FromRgb(180, 80,220), HuMin = -1024,HuMax = 3071, ColorIndex = 8 },
        };
    }
}
