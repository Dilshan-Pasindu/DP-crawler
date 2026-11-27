using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace WinUi3Fixture;

public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
    }

    private void OnSafeClick(object sender, RoutedEventArgs e) => StatusText.Text = "winui-safe-clicked";
    private void OnDeleteClick(object sender, RoutedEventArgs e) => StatusText.Text = "MUTATION_EXECUTED";
    private void OnMenuInspectClick(object sender, RoutedEventArgs e) => StatusText.Text = "menu-clicked";
    private void OnContextClick(object sender, RoutedEventArgs e) => StatusText.Text = "context-clicked";

    private async void OnOpenDialogClick(object sender, RoutedEventArgs e)
    {
        var dialog = new ContentDialog
        {
            Title = "WinUI 3 Fixture Dialog",
            Content = "Predictable modal dialog state.",
            CloseButtonText = "Close",
            XamlRoot = Content.XamlRoot,
        };
        await dialog.ShowAsync();
        StatusText.Text = "dialog-closed";
    }

    private void OnReplaceClick(object sender, RoutedEventArgs e)
    {
        var replacement = new Button { Content = "Replacement Complete" };
        DynamicHost.Child = replacement;
        StatusText.Text = "replaced";
    }
}
