using System.Windows;

namespace MediSeg.WPF
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            // fo-dicom은 별도 초기화 없이 기본 사용 가능
        }
    }
}
