#include <cstdlib>
#include <filesystem>
#include <iostream>

int main() {
  std::cerr << "Working directory: " << std::filesystem::current_path() << "\n";
  for (const char* const name : {"BUILD_WORKING_DIRECTORY", "BUILD_WORKSPACE_DIRECTORY"}) {
    std::cerr << name << ": ";
    if (const char* const value = std::getenv(name))
      std::cerr << value << "\n";
    else
      std::cerr << "<null>\n";
  }

  // Testing .env loading
  const char* env = std::getenv("CONDITIONNED_THINGS");
  if (env == nullptr) {
    std::cerr << "Cannot find env\n";
  } else {
    std::cerr << "Found CONDITIONNED_THINGS=" << env << "\n";
  }
  return 0;
}
