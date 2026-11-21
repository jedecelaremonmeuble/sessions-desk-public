using System.Security;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace SessionsDesk.Driver;

/// <summary>
/// Notification Windows — même XML et même expéditeur que <c>Show-Toast</c> du serveur PowerShell : l'AUMID de
/// Windows PowerShell, déjà enregistré sur tout poste Windows (une appli non empaquetée n'a pas le sien).
/// Le clic ouvre <c>launch</c> par protocole (<c>cc-focus://&lt;pid&gt;</c> ou l'URL de la page).
/// </summary>
static class Toast
{
    const string Aumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

    public static string Xml(string title, string text, string launch) =>
        $"<toast activationType=\"protocol\" launch=\"{SecurityElement.Escape(launch)}\"><visual><binding template=\"ToastGeneric\"><text>{SecurityElement.Escape(title)}</text><text>{SecurityElement.Escape(text)}</text></binding></visual></toast>";

    public static void Show(string title, string text, string launch)
    {
        var d = new XmlDocument();
        d.LoadXml(Xml(title, text, launch));
        ToastNotificationManager.CreateToastNotifier(Aumid).Show(new ToastNotification(d));
    }
}
