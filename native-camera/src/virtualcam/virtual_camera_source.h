#pragma once

#include <unknwn.h>

namespace morphly::virtualcam
{
    bool CanUnloadModule() noexcept;
    HRESULT CreateClassFactory(REFCLSID classId, REFIID interfaceId, void** object) noexcept;
}
