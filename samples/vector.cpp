#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

template <typename T>
class Stack {
public:
    void push(const T& v) { data_.push_back(v); }
    T pop() {
        T v = data_.back();
        data_.pop_back();
        return v;
    }
    bool empty() const { return data_.empty(); }

private:
    std::vector<T> data_;
};

int main() {
    Stack<std::string> s;
    for (const auto& w : {"alpha", "beta", "gamma"}) s.push(w);
    while (!s.empty()) std::cout << s.pop() << '\n';
    std::vector<int> v{5, 3, 9, 1};
    std::sort(v.begin(), v.end(), [](int a, int b) { return a > b; });
    return 0;
}
