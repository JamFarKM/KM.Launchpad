using Microsoft.AspNetCore.DataProtection;

namespace PipelineLaunchpad.Server.Services;

/// <summary>Encrypts/decrypts Azure DevOps PATs before they touch the database.</summary>
public class PatProtector(IDataProtectionProvider provider)
{
    private readonly IDataProtector _protector = provider.CreateProtector("PipelineLaunchpad.Pat.v1");

    public string Protect(string pat) => _protector.Protect(pat);
    public string Unprotect(string encrypted) => _protector.Unprotect(encrypted);
}
