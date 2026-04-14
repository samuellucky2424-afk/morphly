# Release Process

## Creating a New Release

This project uses GitHub Actions to automatically build and release the Electron app as an EXE file.

### Current Version: 1.0.0

### How to Create a Release

1. **Update the version in package.json** (if needed):
   ```bash
   cd .push-fix/app
   # Edit package.json and update the "version" field
   ```

2. **Commit your changes**:
   ```bash
   git add .
   git commit -m "Release version 1.0.0"
   ```

3. **Create and push a version tag**:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

4. **GitHub Actions will automatically**:
   - Build the Electron app
   - Create a GitHub release with the version tag
   - Upload two EXE files:
     - `Morphly-Desktop-Setup-v1.0.0.exe` (NSIS installer)
     - `Morphly-Desktop-Portable-v1.0.0.exe` (Portable version)

### Manual Trigger

You can also manually trigger the release workflow from the GitHub Actions tab:
1. Go to Actions → Release
2. Click "Run workflow"
3. Select the branch and click "Run workflow"

### Build Outputs

The workflow creates two types of Windows executables:
- **NSIS Installer**: Full installer with uninstall capability
- **Portable**: Standalone executable that doesn't require installation

### Version Naming Convention

- Use semantic versioning: `MAJOR.MINOR.PATCH`
- Tag format: `v1.0.0`
- Example tags: `v1.0.0`, `v1.0.1`, `v1.1.0`, `v2.0.0`
