#!/bin/bash

# Script to create a new release
# Usage: ./create-release.sh

VERSION="1.0.0"
TAG="v${VERSION}"

echo "Creating release for version ${VERSION}"
echo "================================"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Error: Tag $TAG already exists!"
    echo "To delete it locally: git tag -d $TAG"
    echo "To delete it remotely: git push origin :refs/tags/$TAG"
    exit 1
fi

# Ensure we're on the latest commit
echo "Current branch: $(git branch --show-current)"
echo "Latest commit: $(git log -1 --oneline)"
echo ""

read -p "Do you want to create tag $TAG for this commit? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Create the tag
    git tag -a "$TAG" -m "Release version ${VERSION}"
    
    echo "Tag $TAG created successfully!"
    echo ""
    echo "To push the tag and trigger the release workflow, run:"
    echo "  git push origin $TAG"
    echo ""
    echo "Or to push all tags:"
    echo "  git push --tags"
else
    echo "Release cancelled."
    exit 0
fi
