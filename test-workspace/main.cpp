#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string_view>

int main() {
  std::cerr << "Working directory: " << std::filesystem::current_path() << "\n";
  for (const char* const name : {"BUILD_WORKING_DIRECTORY", "BUILD_WORKSPACE_DIRECTORY"}) {
    std::cerr << name << ": ";
    if (const char* const value = std::getenv(name)) std::cerr << value << "\n";
    else std::cerr << "<null>\n";
  }
  return 0;
}
